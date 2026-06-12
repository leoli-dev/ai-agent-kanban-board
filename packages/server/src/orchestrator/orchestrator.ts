import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { Project, Task } from '@akb/shared';
import { SAFETY_TICK_MS } from '../config.js';
import { schema, type Db } from '../db/index.js';
import { toProject } from '../db/mappers.js';
import { getTask, listProjectTasks, updateTask } from '../db/task-store.js';
import type { SettingsStore } from '../db/settings-store.js';
import type { AgentRunner } from '../runner/agent-runner.js';
import type { Notifier } from '../notify/notifier.js';
import type { WsHub } from '../ws/hub.js';
import { commitAll, currentBranch, ensureBranch, isDirty } from '../workspace/git.js';
import { workspacePaths } from '../workspace/workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODER_CONTRACT = fs.readFileSync(path.join(__dirname, '../agents/prompts/coder.md'), 'utf8');
const DEBUGGER_CONTRACT = fs.readFileSync(
  path.join(__dirname, '../agents/prompts/debugger.md'),
  'utf8',
);

interface OrchestratorDeps {
  db: Db;
  hub: WsHub;
  runner: AgentRunner;
  settings: SettingsStore;
  notifier: Notifier;
  workspacesDir: string;
}

/**
 * The job-worker loop: each evaluation pass picks ready tasks (deps done,
 * capacity available) and launches coder sub-agents. Event-driven via nudge()
 * with a safety tick to catch missed events, cooldown expiry and restarts.
 */
export class Orchestrator {
  private activeTasks = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private evaluating = false;

  constructor(private deps: OrchestratorDeps) {}

  start(): void {
    // Tasks left in wip by a previous server process have no live agent: re-queue.
    const orphaned = this.deps.db.select().from(schema.tasks).where(eq(schema.tasks.status, 'wip')).all();
    for (const t of orphaned) {
      updateTask(this.deps.db, this.deps.hub, t.id, { status: 'backlog' });
    }
    this.timer = setInterval(() => this.nudge(), SAFETY_TICK_MS);
    this.timer.unref?.();
    this.nudge();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Schedule an evaluation pass (re-entrancy safe). */
  nudge(): void {
    if (this.evaluating) return;
    this.evaluating = true;
    setImmediate(() => {
      try {
        this.evaluate();
      } finally {
        this.evaluating = false;
      }
    });
  }

  private evaluate(): void {
    const projects = this.deps.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.status, 'running'))
      .all()
      .map(toProject);

    const capacityTotal = this.deps.settings.get().concurrency;

    for (const project of projects) {
      const tasks = listProjectTasks(this.deps.db, project.id);

      if (tasks.length > 0 && tasks.every((t) => t.status === 'done')) {
        this.completeProject(project);
        continue;
      }

      // A dependency is satisfied once its coding work is committed
      // (to_review or later) — review/test stages must not stall the pipeline.
      const satisfied = new Set(
        tasks
          .filter((t) => ['to_review', 'to_test', 'done'].includes(t.status))
          .map((t) => t.id),
      );
      const ready = tasks.filter(
        (t) =>
          t.status === 'backlog' &&
          !this.activeTasks.has(t.id) &&
          t.dependsOn.every((d) => satisfied.has(d)),
      );

      for (const task of ready) {
        if (this.activeTasks.size >= capacityTotal) return;
        this.activeTasks.add(task.id);
        void this.runCoderStage(project, task).finally(() => {
          this.activeTasks.delete(task.id);
          this.nudge();
        });
      }
    }
  }

  private async runCoderStage(project: Project, task: Task): Promise<void> {
    const ws = workspacePaths(this.deps.workspacesDir, project.id);
    try {
      const prepError = await this.prepareRepo(project);
      if (prepError) {
        updateTask(this.deps.db, this.deps.hub, task.id, {
          status: 'blocked',
          blockedReason: prepError,
        });
        await this.deps.notifier.notify(
          'task_failed',
          `Task blocked: ${task.title}`,
          prepError,
          project.id,
        );
        return;
      }

      updateTask(this.deps.db, this.deps.hub, task.id, { status: 'wip', blockedReason: null });

      const outcome = await this.deps.runner.run({
        role: 'coder',
        prompt: this.buildCoderPrompt(project, task, ws.artifacts),
        cwd: project.targetRepoPath,
        logDir: ws.logs,
        taskId: task.id,
        projectId: project.id,
        addDirs: [ws.root],
        systemAppend: CODER_CONTRACT,
        onStuck: (info) => this.diagnoseStuckRun(project, task, info.logTail, ws.artifacts),
      });

      if (outcome.ok) {
        // Safety net: commit anything the agent left uncommitted.
        try {
          await commitAll(project.targetRepoPath, `task(${task.planStepId ?? task.id}): ${task.title} (auto-commit)`);
        } catch {
          /* repo state issues surface in review */
        }
        updateTask(this.deps.db, this.deps.hub, task.id, { status: 'to_review' });
        this.deps.hub.publish(`board:${project.id}`, {
          type: 'task.updated',
          task: getTask(this.deps.db, task.id)!,
        });
        return;
      }

      if (outcome.blocked) {
        updateTask(this.deps.db, this.deps.hub, task.id, {
          status: 'blocked',
          blockedReason: 'all AI providers for the coder role are exhausted or disabled',
        });
        await this.deps.notifier.notify(
          'provider_down',
          'Coder providers exhausted',
          `Task "${task.title}" is blocked until a provider recovers.`,
          project.id,
        );
        return;
      }

      await this.handleTaskFailure(project, task, outcome.finalRun?.resultText ?? 'no result');
    } catch (err) {
      await this.handleTaskFailure(project, task, String(err));
    }
  }

  private async handleTaskFailure(project: Project, task: Task, reason: string): Promise<void> {
    const fresh = getTask(this.deps.db, task.id);
    if (!fresh) return;
    const maxRetries = this.deps.settings.get().maxRetries;
    if (fresh.retryCount < maxRetries) {
      updateTask(this.deps.db, this.deps.hub, task.id, {
        status: 'backlog',
        retryCount: fresh.retryCount + 1,
      });
      this.nudge();
    } else {
      updateTask(this.deps.db, this.deps.hub, task.id, { status: 'failed' });
      await this.deps.notifier.notify(
        'task_failed',
        `Task failed: ${task.title}`,
        `Gave up after ${maxRetries} retries. Last error: ${reason.slice(0, 500)}`,
        project.id,
      );
    }
  }

  /** Runs while the stuck process is still alive; writes a diagnosis artifact
   * that the next retry attempt picks up. */
  private async diagnoseStuckRun(
    project: Project,
    task: Task,
    logTail: string,
    artifactsDir: string,
  ): Promise<void> {
    try {
      const outcome = await this.deps.runner.run({
        role: 'debugger',
        prompt: `## Stuck task\n${task.title}\n\n${task.description}\n\n## Execution log tail\n\`\`\`\n${logTail.slice(-20_000)}\n\`\`\`\n\nDiagnose per your instructions.`,
        cwd: project.targetRepoPath,
        logDir: workspacePaths(this.deps.workspacesDir, project.id).logs,
        projectId: project.id,
        addDirs: [],
        systemAppend: DEBUGGER_CONTRACT,
        timeouts: { stuckMs: 5 * 60_000, wallClockMs: 10 * 60_000 },
      });
      const diagnosis = outcome.finalRun?.resultText;
      if (diagnosis) {
        fs.writeFileSync(
          path.join(artifactsDir, `diagnosis-${task.id}-${Date.now()}.md`),
          diagnosis,
        );
      }
    } catch {
      /* diagnosis is best-effort */
    }
  }

  private buildCoderPrompt(project: Project, task: Task, artifactsDir: string): string {
    const criteria = task.acceptanceCriteria.length
      ? task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
      : '- (none specified — use your judgement)';

    let retryContext = '';
    if (task.retryCount > 0) {
      const lastDiagnosis = latestDiagnosis(artifactsDir, task.id);
      const lastFail = this.deps.db
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.taskId, task.id))
        .all()
        .filter((r) => r.status !== 'running')
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      retryContext =
        `\n## Previous attempt (#${task.retryCount}) failed` +
        (lastFail?.resultText ? `\nLast output:\n${lastFail.resultText.slice(-1500)}` : '') +
        (lastDiagnosis ? `\n\nDebugger diagnosis of the stall:\n${lastDiagnosis}` : '') +
        `\nThe repository may contain partial work from that attempt — inspect git status/log first and continue or redo as appropriate.\n`;
    }

    return `# Project: ${project.name}
${project.prompt.slice(0, 1000)}

# Your task: ${task.title}

${task.description}

## Acceptance criteria
${criteria}
${retryContext}
## Working agreement
- Current git branch: ${project.gitBranch} (already checked out — stay on it)
- Commit message format: task(${task.planStepId ?? task.id}): <what you did>
- You may write progress notes to: ${artifactsDir}

Begin.`;
  }

  /** Checkout/create the agent branch; refuse if user changes could be clobbered. */
  private async prepareRepo(project: Project): Promise<string | null> {
    if (!project.gitBranch) return 'project has no agent branch configured';
    try {
      const branch = await currentBranch(project.targetRepoPath);
      if (branch !== project.gitBranch) {
        if (await isDirty(project.targetRepoPath)) {
          return `target repo has uncommitted changes on branch "${branch}" — commit or stash them first`;
        }
        await ensureBranch(project.targetRepoPath, project.gitBranch);
      }
      return null;
    } catch (err) {
      return `failed to prepare git branch: ${String(err)}`;
    }
  }

  private completeProject(project: Project): void {
    this.deps.db
      .update(schema.projects)
      .set({ status: 'done', completedAt: Date.now() })
      .where(eq(schema.projects.id, project.id))
      .run();
    const updated = toProject(
      this.deps.db.select().from(schema.projects).where(eq(schema.projects.id, project.id)).get()!,
    );
    this.deps.hub.publish('global', { type: 'project.updated', project: updated });
    this.deps.hub.publish(`board:${project.id}`, { type: 'project.updated', project: updated });
    void this.deps.notifier.notify(
      'project_done',
      `Project complete: ${project.name}`,
      `All tasks are done. Review the result on branch ${project.gitBranch} of ${project.targetRepoPath}.`,
      project.id,
    );
  }
}

function latestDiagnosis(artifactsDir: string, taskId: string): string | null {
  try {
    const files = fs
      .readdirSync(artifactsDir)
      .filter((f) => f.startsWith(`diagnosis-${taskId}-`))
      .sort();
    const last = files[files.length - 1];
    return last ? fs.readFileSync(path.join(artifactsDir, last), 'utf8') : null;
  } catch {
    return null;
  }
}
