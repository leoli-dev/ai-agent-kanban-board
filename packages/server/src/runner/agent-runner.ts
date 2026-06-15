import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { AgentRole, AgentRun, FailureClass, ModelTier, ProviderProfile } from '@akb/shared';
import { QUOTA_COOLDOWN_MS, RUN_EVENT_THROTTLE_PER_SEC } from '../config.js';
import { getAdapter } from '../engines/index.js';
import type { NormalizedEvent, NormalizedResult } from '../engines/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { SettingsStore } from '../db/settings-store.js';
import type { WsHub } from '../ws/hub.js';
import { LineSplitter } from './stream-parser.js';
import type { RunStore } from './run-store.js';
import { Watchdog } from './watchdog.js';

export interface RunRequest {
  role: AgentRole;
  prompt: string;
  cwd: string;
  logDir: string;
  taskId?: string;
  projectId?: string;
  addDirs?: string[];
  systemAppend?: string;
  /** Resume an engine session. Requires profileId (sessions are per-provider). */
  resumeSessionId?: string;
  /** Pin a specific profile instead of role-based selection. */
  profileId?: string;
  /**
   * Intelligence floor for model selection: skip models below this tier so a
   * repeatedly-rejected task retries on a more capable model. Default 'low'.
   */
  minTier?: ModelTier;
  images?: string[];
  /** Test/role overrides for watchdog timers. */
  timeouts?: { stuckMs?: number; wallClockMs?: number };
  /**
   * Called when the stuck timer fires, while the process is still alive
   * (e.g. to run a debugger agent over the log tail). After it resolves the
   * process is killed and the attempt finalized as 'stuck'.
   */
  onStuck?: (info: { run: AgentRun; logTail: string }) => Promise<void> | void;
}

export interface RunOutcome {
  ok: boolean;
  failureClass: FailureClass;
  /** True when every eligible provider for the role was exhausted. */
  blocked: boolean;
  finalRun: AgentRun | null;
  attempts: AgentRun[];
}

type Terminal = 'exit' | 'stuck' | 'wall' | 'external';

interface AttemptResult {
  terminal: Terminal;
  exitCode: number | null;
  failureClass: FailureClass;
  run: AgentRun;
  lastResult?: NormalizedResult;
}

interface ActiveRun {
  child: ChildProcess;
  killedAs: Terminal | null;
}

export class AgentRunner extends EventEmitter {
  private active = new Map<string, ActiveRun>();

  constructor(
    private deps: {
      registry: ProviderRegistry;
      runStore: RunStore;
      settings: SettingsStore;
      hub: WsHub;
    },
    private opts: { crashRetryDelayMs?: number } = {},
  ) {
    super();
  }

  /** Run a prompt under a role, with provider fallback. Resolves when done. */
  async run(req: RunRequest): Promise<RunOutcome> {
    const attempts: AgentRun[] = [];
    const triedProfileIds: string[] = [];
    let crashRetried = false;
    let resumeSessionId = req.resumeSessionId;
    let lastFailureText: string | undefined;

    let profile = req.profileId
      ? this.deps.registry.get(req.profileId)
      : this.deps.registry.pickForRole(req.role, [], req.minTier ?? 'low');

    while (profile) {
      const prompt =
        attempts.length === 0
          ? req.prompt
          : `Note: a previous attempt by another AI provider was interrupted before completing.` +
            (lastFailureText ? ` Its last output was:\n---\n${lastFailureText.slice(-2000)}\n---\n` : '\n') +
            `Continue the work from the current state. Original instructions:\n\n${req.prompt}`;

      const attempt = await this.attempt(req, profile, prompt, resumeSessionId);
      attempts.push(attempt.run);

      if (attempt.terminal !== 'exit') {
        // stuck / wall-clock / external kill: task-level concern, no provider fallback
        return { ok: false, failureClass: 'TASK_FAIL', blocked: false, finalRun: attempt.run, attempts };
      }

      switch (attempt.failureClass) {
        case 'OK':
          this.deps.registry.markOk(profile.id);
          return { ok: true, failureClass: 'OK', blocked: false, finalRun: attempt.run, attempts };
        case 'TASK_FAIL':
          return { ok: false, failureClass: 'TASK_FAIL', blocked: false, finalRun: attempt.run, attempts };
        case 'QUOTA':
          this.deps.registry.markCooldown(profile.id, Date.now() + QUOTA_COOLDOWN_MS, 'quota/rate limit');
          this.emit('provider_down', { profile, reason: 'quota', permanent: false });
          break;
        case 'AUTH':
          this.deps.registry.markDisabled(profile.id, 'authentication failure');
          this.emit('provider_down', { profile, reason: 'auth', permanent: true });
          break;
        case 'CRASH':
          if (!crashRetried) {
            crashRetried = true;
            await sleep(this.opts.crashRetryDelayMs ?? 10_000);
            continue; // same profile, one retry
          }
          break;
      }

      lastFailureText = attempt.lastResult?.text ?? attempt.run.resultText ?? undefined;
      triedProfileIds.push(profile.id);
      resumeSessionId = undefined; // sessions don't survive provider switches
      crashRetried = false;
      profile = req.profileId
        ? null
        : this.deps.registry.pickForRole(req.role, triedProfileIds, req.minTier ?? 'low');
    }

    const finalRun = attempts[attempts.length - 1] ?? null;
    return {
      ok: false,
      failureClass: finalRun?.failureClass ?? 'CRASH',
      blocked: true,
      finalRun,
      attempts,
    };
  }

  /** Kill a running attempt from outside (UI button, orchestrator). */
  kill(runId: string): boolean {
    const active = this.active.get(runId);
    if (!active) return false;
    active.killedAs = 'external';
    terminate(active.child);
    return true;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /**
   * Mark 'running' rows left by a previous server process as 'interrupted' —
   * a restart/crash is not a real failure, so it must not count toward failure
   * stats or show as a red FAIL. The orchestrator re-queues the owning task.
   */
  recoverOrphans(): void {
    for (const run of this.deps.runStore.listRunning()) {
      if (this.active.has(run.id)) continue;
      if (run.pid) {
        try {
          process.kill(run.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      this.deps.runStore.update(run.id, {
        status: 'interrupted',
        endedAt: Date.now(),
        resultText: 'interrupted by server restart',
        failureClass: null,
      });
    }
  }

  private attempt(
    req: RunRequest,
    profile: ProviderProfile,
    prompt: string,
    resumeSessionId: string | undefined,
  ): Promise<AttemptResult> {
    return new Promise((resolveAttempt) => {
      const settings = this.deps.settings.get();
      const stuckMs = req.timeouts?.stuckMs ?? settings.stuckThresholdMin * 60_000;
      const wallClockMs = req.timeouts?.wallClockMs ?? settings.wallClockLimitMin * 60_000;
      const adapter = getAdapter(profile.engine);
      const runId = nanoid(12);
      fs.mkdirSync(req.logDir, { recursive: true });
      const logPath = path.join(req.logDir, `run-${runId}.ndjson`);
      const logStream = fs.createWriteStream(logPath, { flags: 'a' });

      let resolved: ResolvedReturn | null = null;
      try {
        resolved = { profile: this.deps.registry.resolve(profile) };
      } catch (err) {
        // Missing secret: treat like an auth failure so fallback proceeds.
        logStream.end();
        const run = this.deps.runStore.create({
          id: runId,
          taskId: req.taskId,
          projectId: req.projectId,
          role: req.role,
          providerProfileId: profile.id,
          logPath,
        });
        const failed = this.deps.runStore.update(run.id, {
          status: 'failed',
          failureClass: 'AUTH',
          endedAt: Date.now(),
          resultText: String(err),
        })!;
        resolveAttempt({ terminal: 'exit', exitCode: null, failureClass: 'AUTH', run: failed });
        return;
      }

      const spec = adapter.buildSpawn({
        prompt,
        profile: resolved.profile,
        cwd: req.cwd,
        addDirs: req.addDirs ?? [],
        systemAppend: req.systemAppend,
        resumeSessionId,
        images: req.images,
      });

      logStream.write(
        JSON.stringify({
          type: 'akb-meta',
          ts: Date.now(),
          role: req.role,
          profile: profile.name,
          engine: profile.engine,
          cmd: spec.cmd,
          cwd: req.cwd,
        }) + '\n',
      );

      const child = spawn(spec.cmd, spec.args, {
        cwd: req.cwd,
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const run = this.deps.runStore.create({
        id: runId,
        taskId: req.taskId,
        projectId: req.projectId,
        role: req.role,
        providerProfileId: profile.id,
        logPath,
        pid: child.pid ?? null,
      });
      this.active.set(runId, { child, killedAs: null });

      let lastResult: NormalizedResult | undefined;
      let sessionId: string | null = null;
      let usage: { input?: number; output?: number; cost?: number; turns?: number } = {};
      let stderrTail = '';
      let lastBeatWrite = 0;
      let wsWindowStart = 0;
      let wsWindowCount = 0;
      let stuckHandled = false;

      const watchdog = new Watchdog({
        stuckMs,
        wallClockMs,
        onStuck: () => {
          if (stuckHandled) return;
          stuckHandled = true;
          void (async () => {
            const active = this.active.get(runId);
            if (!active || active.killedAs) return;
            if (req.onStuck) {
              try {
                const logTail = readTail(logPath, 64 * 1024);
                await req.onStuck({ run: this.deps.runStore.get(runId)!, logTail });
              } catch {
                /* diagnosis failures must not block the kill */
              }
            }
            const stillActive = this.active.get(runId);
            if (stillActive && !stillActive.killedAs) {
              stillActive.killedAs = 'stuck';
              terminate(child);
            }
          })();
        },
        onWallClock: () => {
          const active = this.active.get(runId);
          if (active && !active.killedAs) {
            active.killedAs = 'wall';
            terminate(child);
          }
        },
      });
      watchdog.start();

      const onEvent = (line: string, event: NormalizedEvent | null): void => {
        const now = Date.now();
        watchdog.beat();
        logStream.write(line + '\n');
        if (now - lastBeatWrite > 1000) {
          lastBeatWrite = now;
          this.deps.runStore.beat(runId, now);
        }
        if (!event) return;
        if (event.kind === 'init') {
          sessionId = event.sessionId;
          this.deps.runStore.update(runId, { engineSessionId: sessionId });
        } else if (event.kind === 'result') {
          lastResult = { ok: event.ok, subtype: event.subtype, text: event.text };
          usage = {
            input: event.inputTokens,
            output: event.outputTokens,
            cost: event.costUsd,
            turns: event.numTurns,
          };
        }
        // Throttled live feed to the UI; init/result always go through.
        if (event.kind === 'init' || event.kind === 'result') {
          this.publishEvent(runId, req.projectId, event);
        } else {
          if (now - wsWindowStart > 1000) {
            wsWindowStart = now;
            wsWindowCount = 0;
          }
          if (wsWindowCount < RUN_EVENT_THROTTLE_PER_SEC) {
            wsWindowCount++;
            this.publishEvent(runId, req.projectId, event);
          }
        }
      };

      const parseState: Record<string, unknown> = {};
      const splitter = new LineSplitter((line) => onEvent(line, adapter.parseLine(line, parseState)));
      child.stdout?.on('data', (chunk: Buffer) => splitter.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-16 * 1024);
        logStream.write(JSON.stringify({ type: 'akb-stderr', ts: Date.now(), text }) + '\n');
        watchdog.beat();
      });

      let spawnError: Error | null = null;
      child.on('error', (err) => {
        spawnError = err;
        stderrTail += `\nspawn error: ${err.message}`;
      });

      child.on('close', (exitCode) => {
        watchdog.stop();
        splitter.flush();
        logStream.end();
        const active = this.active.get(runId);
        const terminal: Terminal = active?.killedAs ?? 'exit';
        this.active.delete(runId);

        let failureClass: FailureClass;
        let status: AgentRun['status'];
        let resultText: string | null = lastResult?.text ?? null;

        if (terminal === 'exit') {
          failureClass = spawnError
            ? 'CRASH'
            : adapter.classify(exitCode, stderrTail, lastResult);
          status = failureClass === 'OK' ? 'succeeded' : 'failed';
          if (spawnError) resultText = `spawn error: ${spawnError.message}`;
        } else if (terminal === 'stuck') {
          failureClass = 'TASK_FAIL';
          status = 'stuck';
          resultText = 'killed: no progress (stuck watchdog)';
        } else if (terminal === 'wall') {
          failureClass = 'TASK_FAIL';
          status = 'killed';
          resultText = 'killed: wall-clock limit exceeded';
        } else {
          failureClass = 'TASK_FAIL';
          status = 'killed';
          resultText = 'killed by user/orchestrator';
        }

        const finalRun = this.deps.runStore.update(runId, {
          status,
          failureClass,
          endedAt: Date.now(),
          exitCode,
          resultText,
          numTurns: usage.turns ?? null,
          inputTokens: usage.input ?? null,
          outputTokens: usage.output ?? null,
          costUsd: usage.cost ?? null,
        })!;

        resolveAttempt({ terminal, exitCode, failureClass, run: finalRun, lastResult });
      });
    });
  }

  private publishEvent(runId: string, projectId: string | undefined, event: NormalizedEvent): void {
    const payload = {
      type: 'run.event' as const,
      runId,
      event: {
        kind: event.kind,
        text: 'text' in event ? event.text : undefined,
        tool: 'tool' in event ? event.tool : undefined,
        detail: 'detail' in event ? event.detail : undefined,
        ts: Date.now(),
      },
    };
    this.deps.hub.publish(`run:${runId}`, payload);
    if (projectId) this.deps.hub.publish(`board:${projectId}`, payload);
  }
}

interface ResolvedReturn {
  profile: import('../engines/types.js').ResolvedProfile;
}

function terminate(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }, 10_000);
  child.once('close', () => clearTimeout(timer));
  timer.unref?.();
}

function readTail(filePath: string, bytes: number): string {
  try {
    const stat = fs.statSync(filePath);
    const fd = fs.openSync(filePath, 'r');
    const start = Math.max(0, stat.size - bytes);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString();
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
