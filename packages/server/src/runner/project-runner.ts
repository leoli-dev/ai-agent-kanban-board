import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Project } from '@akb/shared';
import { schema, type Db } from '../db/index.js';
import { toProject } from '../db/mappers.js';
import type { WsHub } from '../ws/hub.js';

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s'"]*)?/i;
const PROBE_AFTER_MS = 20_000;

interface RunPlan {
  /** Shell command that installs/builds (if needed) and starts a server. */
  command: string;
  /** Human label for the report (e.g. "npm run dev"). */
  label: string;
}

interface Running {
  child: ChildProcess;
  logPath: string;
}

/**
 * Hosts a finished project's app as a long-lived background process so the user
 * gets a live preview URL. One process per project; restart-safe; stopped on
 * project delete / server shutdown.
 */
export class ProjectRunner {
  private procs = new Map<string, Running>();

  constructor(private deps: { db: Db; hub: WsHub; workspacesDir: string }) {}

  isRunning(projectId: string): boolean {
    return this.procs.has(projectId);
  }

  /** Best-effort: install/build/start the project and detect its served URL. */
  async start(project: Project): Promise<void> {
    this.stop(project.id); // restart-safe
    const cwd = project.targetRepoPath;
    const plan = detectRunPlan(cwd);
    if (!plan) {
      this.patch(project.id, { liveUrl: null, runPid: null });
      return; // not a runnable web project
    }

    const port = await freePort();
    const logPath = path.join(this.deps.workspacesDir, project.id, 'logs', 'preview.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const out = fs.createWriteStream(logPath, { flags: 'w' });
    out.write(`$ ${plan.command}\n(PORT=${port})\n\n`);

    const child = spawn('bash', ['-lc', plan.command], {
      cwd,
      env: { ...process.env, PORT: String(port), BROWSER: 'none', CI: '1', FORCE_COLOR: '0' },
      detached: true, // own process group, so we can kill the whole tree
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.procs.set(project.id, { child, logPath });
    this.patch(project.id, { runPid: child.pid ?? null, liveUrl: null });

    let url: string | null = null;
    const setUrl = (u: string) => {
      if (url) return;
      url = normalizeUrl(u, port);
      this.patch(project.id, { liveUrl: url });
    };
    const onData = (buf: Buffer) => {
      const text = buf.toString();
      out.write(text);
      const m = text.match(URL_RE);
      if (m) setUrl(m[0]);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('exit', () => {
      out.end();
      this.procs.delete(project.id);
      // If it never served, clear the URL; if it had served and later crashed,
      // keep the URL but drop the pid so the UI shows it's no longer hosted.
      this.patch(project.id, { runPid: null, ...(url ? {} : { liveUrl: null }) });
    });

    // Some servers honor PORT but never print a URL — probe the port directly.
    setTimeout(() => {
      if (url || !this.procs.has(project.id)) return;
      void portOpen(port).then((open) => {
        if (open && this.procs.has(project.id)) setUrl(`http://localhost:${port}`);
      });
    }, PROBE_AFTER_MS);
  }

  stop(projectId: string): void {
    const r = this.procs.get(projectId);
    if (r) {
      killTree(r.child);
      this.procs.delete(projectId);
    }
    this.patch(projectId, { runPid: null, liveUrl: null });
  }

  stopAll(): void {
    for (const id of [...this.procs.keys()]) this.stop(id);
  }

  /** Persist run state to the project row and broadcast the change. */
  private patch(projectId: string, set: { liveUrl?: string | null; runPid?: number | null }): void {
    const dbSet: Record<string, unknown> = {};
    if ('liveUrl' in set) dbSet.liveUrl = set.liveUrl ?? null;
    if ('runPid' in set) dbSet.runPid = set.runPid ?? null;
    this.deps.db.update(schema.projects).set(dbSet).where(eq(schema.projects.id, projectId)).run();
    const row = this.deps.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .get();
    if (!row) return;
    const project = toProject(row);
    this.deps.hub.publish('global', { type: 'project.updated', project });
    this.deps.hub.publish(`board:${projectId}`, { type: 'project.updated', project });
  }
}

/** Decide how to install/build/start a project, or null if it's not a web app. */
export function detectRunPlan(cwd: string): RunPlan | null {
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts ?? {}) as Record<string, string>;
    } catch {
      return null;
    }
    const startScript = ['dev', 'start', 'serve', 'preview'].find((s) => scripts[s]);
    if (!startScript) return null;
    const pm = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : fs.existsSync(path.join(cwd, 'yarn.lock'))
        ? 'yarn'
        : 'npm';
    const run = pm === 'npm' ? `npm run ${startScript}` : `${pm} ${startScript}`;
    // Dev servers run from source; preview/serve/start may need a build first.
    const build = startScript !== 'dev' && scripts.build ? ` && ${pm} run build` : '';
    return { command: `${pm} install${build} && ${run}`, label: run };
  }
  // A plain static site: index.html at the root, no build tooling.
  if (fs.existsSync(path.join(cwd, 'index.html'))) {
    return { command: 'python3 -m http.server "$PORT"', label: 'python3 -m http.server' };
  }
  return null;
}

/** Canonicalize a detected URL to a clickable localhost form. */
export function normalizeUrl(raw: string, port: number): string {
  let url = raw
    .replace('://0.0.0.0', '://localhost')
    .replace('://127.0.0.1', '://localhost')
    .replace('://[::1]', '://localhost')
    .replace('://[::]', '://localhost')
    .replace(/[)\].,;'"]+$/, '');
  if (!/:\d+/.test(url)) url = url.replace('://localhost', `://localhost:${port}`);
  return url;
}

function killTree(child: ChildProcess): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      /* fall back to killing just the child */
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => resolve(false));
    sock.setTimeout(1000, () => done(false));
  });
}
