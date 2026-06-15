import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ModelTier, Project, Task } from '@akb/shared';
import type { ProviderRegistry } from '../providers/registry.js';
import { SAFETY_TICK_MS } from '../config.js';
import { schema, type Db } from '../db/index.js';
import { toProject } from '../db/mappers.js';
import { getTask, listProjectTasks, updateTask } from '../db/task-store.js';
import type { SettingsStore } from '../db/settings-store.js';
import type { AgentRunner } from '../runner/agent-runner.js';
import type { ProjectRunner } from '../runner/project-runner.js';
import type { Notifier } from '../notify/notifier.js';
import type { ReportService } from '../reports/report-service.js';
import type { WsHub } from '../ws/hub.js';
import {
  commitAll,
  defaultBranch,
  deleteBranch,
  discardUncommitted,
  ensureNotOnBranch,
  ensureWorktree,
  mergeBaseLeaveConflicts,
  mergeBranchInto,
  mergeIntoCurrent,
  removeWorktree,
} from '../workspace/git.js';
import { workspacePaths } from '../workspace/workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prompt = (name: string) =>
  fs.readFileSync(path.join(__dirname, `../agents/prompts/${name}.md`), 'utf8');
const CODER_CONTRACT = prompt('coder');
const DEBUGGER_CONTRACT = prompt('debugger');
const REVIEWER_CONTRACT = prompt('reviewer');
const TESTER_CONTRACT = prompt('tester');

const ReviewVerdict = z.object({
  verdict: z.enum(['approve', 'changes_requested']),
  notes: z.string().default(''),
});
const TestVerdict = z.object({
  pass: z.boolean(),
  summary: z.string().default(''),
  // Absolute (or cwd/artifacts-relative) paths to screenshots the tester saved.
  evidence: z.array(z.string()).default([]),
});

// A visual/rendering criterion must be backed by a real screenshot. Kept narrow
// to avoid flagging purely backend/CLI tasks.
const VISUAL_CRITERION_RE =
  /screenshot|截图|浏览器|\bbrowser\b|渲染|\brenders?\b|\brendered\b|\brendering\b|可视化|图表|\bchart\b|\bcanvas\b/i;

interface OrchestratorDeps {
  db: Db;
  hub: WsHub;
  runner: AgentRunner;
  projectRunner: ProjectRunner;
  settings: SettingsStore;
  notifier: Notifier;
  registry: ProviderRegistry;
  reports: ReportService;
  workspacesDir: string;
}

/**
 * The job-worker loop: each evaluation pass picks ready tasks (deps done,
 * capacity available) and launches coder sub-agents. Event-driven via nudge()
 * with a safety tick to catch missed events, cooldown expiry and restarts.
 */
export class Orchestrator {
  private activeTasks = new Set<string>();
  private integrating = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private evaluating = false;
  /** Per-project promise chain: serializes worktree setup + merges, which
   * would otherwise race on the repo's index/worktree locks. */
  private gitLocks = new Map<string, Promise<unknown>>();
  /** Last auto-resume attempt per parked task, so a failing stage agent
   * doesn't get relaunched on every tick. */
  private stageResumeAt = new Map<string, number>();
  private static readonly STAGE_RESUME_COOLDOWN_MS = 10 * 60_000;

  constructor(private deps: OrchestratorDeps) {}

  private withGitLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.gitLocks.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.gitLocks.set(
      projectId,
      next.catch(() => {}),
    );
    return next;
  }

  /* ---- worktree layout: each task works on its own branch in an isolated
     worktree; the integration worktree holds the project branch so the
     user's own checkout is never touched. ---- */

  private worktreeDir(project: Project, taskId: string): string {
    return path.join(workspacePaths(this.deps.workspacesDir, project.id).root, 'worktrees', taskId);
  }

  private integrationDir(project: Project): string {
    return this.worktreeDir(project, '_integration');
  }

  private taskBranch(project: Project, task: Task): string {
    return `${project.gitBranch}--task-${task.planStepId ?? task.id}`;
  }

  /** Remove a task's worktree + branch (task finished, failed, or deleted). */
  async cleanupTaskWorktree(project: Project, task: Task): Promise<void> {
    const dir = this.worktreeDir(project, task.id);
    if (fs.existsSync(dir)) await removeWorktree(project.targetRepoPath, dir);
    await deleteBranch(project.targetRepoPath, this.taskBranch(project, task));
  }

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

      // Done tasks whose branch hasn't been merged back yet (covers both the
      // automated pipeline and manual drags to Done).
      for (const task of tasks) {
        if (
          task.status === 'done' &&
          !this.integrating.has(task.id) &&
          fs.existsSync(this.worktreeDir(project, task.id))
        ) {
          this.integrating.add(task.id);
          void this.integrateTask(project, task).finally(() => {
            this.integrating.delete(task.id);
            this.nudge();
          });
        }
      }

      const allMerged = tasks.every(
        (t) => t.status === 'done' && !fs.existsSync(this.worktreeDir(project, t.id)),
      );
      if (tasks.length > 0 && allMerged) {
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
        void this.runTaskPipeline(project, task).finally(() => {
          this.activeTasks.delete(task.id);
          this.nudge();
        });
      }

      // Tasks parked in review/test (pipeline interrupted by a restart, or
      // the stage role was configured after the coder finished): resume the
      // remaining stages.
      const settings = this.deps.settings.get();
      for (const task of tasks) {
        if (this.activeTasks.size >= capacityTotal) return;
        if (this.activeTasks.has(task.id)) continue;
        const wantsReview =
          task.status === 'to_review' &&
          settings.autoAdvanceReview &&
          !!this.deps.registry.pickForRole('reviewer');
        const wantsTest =
          task.status === 'to_test' &&
          settings.autoAdvanceTest &&
          !!this.deps.registry.pickForRole('tester');
        if (!wantsReview && !wantsTest) continue;
        const lastAttempt = this.stageResumeAt.get(task.id) ?? 0;
        if (Date.now() - lastAttempt < Orchestrator.STAGE_RESUME_COOLDOWN_MS) continue;
        this.stageResumeAt.set(task.id, Date.now());
        this.activeTasks.add(task.id);
        void this.resumeStages(project, task, wantsReview ? 'review' : 'test').finally(() => {
          this.activeTasks.delete(task.id);
          this.nudge();
        });
      }
    }
  }

  /**
   * Prepare the task's isolated worktree: integration branch first, then the
   * task branch from it; on re-runs, merge fresh integrated work into the
   * task branch (conflicts are left for the coder to resolve).
   */
  private prepareTaskWorktree(
    project: Project,
    task: Task,
  ): Promise<{ cwd: string; branch: string; mergeConflict: boolean } | { error: string }> {
    return this.withGitLock(project.id, () => this.prepareTaskWorktreeLocked(project, task));
  }

  private async prepareTaskWorktreeLocked(
    project: Project,
    task: Task,
  ): Promise<{ cwd: string; branch: string; mergeConflict: boolean } | { error: string }> {
    if (!project.gitBranch) return { error: 'project has no agent branch configured' };
    try {
      // Legacy migration: pre-worktree projects left the user's checkout on
      // the agent branch, which would block the integration worktree.
      await ensureNotOnBranch(project.targetRepoPath, project.gitBranch);
      await ensureWorktree(
        project.targetRepoPath,
        this.integrationDir(project),
        project.gitBranch,
        'HEAD',
      );
      const dir = this.worktreeDir(project, task.id);
      const branch = this.taskBranch(project, task);
      const existed = fs.existsSync(dir);
      await ensureWorktree(project.targetRepoPath, dir, branch, project.gitBranch);
      let mergeConflict = false;
      if (existed) {
        mergeConflict = (await mergeBaseLeaveConflicts(dir, project.gitBranch)) === 'conflict';
      }
      return { cwd: dir, branch, mergeConflict };
    } catch (err) {
      return { error: `failed to prepare task worktree: ${String(err)}` };
    }
  }

  /** Merge a finished task's branch into the project branch. */
  private integrateTask(project: Project, task: Task): Promise<void> {
    return this.withGitLock(project.id, () => this.integrateTaskLocked(project, task));
  }

  private async integrateTaskLocked(project: Project, task: Task): Promise<void> {
    try {
      const integration = this.integrationDir(project);
      await ensureWorktree(project.targetRepoPath, integration, project.gitBranch!, 'HEAD');
      const result = await mergeIntoCurrent(
        integration,
        this.taskBranch(project, task),
        `merge task(${task.planStepId ?? task.id}): ${task.title}`,
      );
      if (result === 'ok') {
        await this.cleanupTaskWorktree(project, task);
        return;
      }
      // Conflict with work merged in the meantime: send the task back; the
      // next attempt pre-merges the new base and the coder resolves it.
      fs.writeFileSync(
        path.join(
          workspacePaths(this.deps.workspacesDir, project.id).artifacts,
          `feedback-${task.id}.md`,
        ),
        `Your branch conflicts with work merged after you finished. The new base has been merged into your branch with conflict markers — resolve them, re-verify the acceptance criteria, and commit.`,
      );
      await this.handleTaskFailure(project, task, 'merge conflict with integrated work');
    } catch (err) {
      await this.handleTaskFailure(project, task, `integration failed: ${String(err)}`);
    }
  }

  /** coder -> (reviewer) -> (tester) for a single task, honoring auto-advance. */
  private async runTaskPipeline(project: Project, task: Task): Promise<void> {
    const ws = workspacePaths(this.deps.workspacesDir, project.id);
    try {
      const prep = await this.prepareTaskWorktree(project, task);
      if ('error' in prep) {
        updateTask(this.deps.db, this.deps.hub, task.id, {
          status: 'blocked',
          blockedReason: prep.error,
        });
        await this.deps.notifier.notify(
          'task_failed',
          `Task blocked: ${task.title}`,
          prep.error,
          project.id,
        );
        return;
      }

      updateTask(this.deps.db, this.deps.hub, task.id, { status: 'wip', blockedReason: null });

      // Escalate the coder's intelligence tier with each prior rejection
      // (review/test bounce) or hard-failure retry: a weaker model that can't
      // get its work accepted hands off to a more capable one. 0 prior → low,
      // 1 → medium, 2+ → high.
      const escalation = task.bounceCount + task.retryCount;
      const minTier: ModelTier = escalation >= 2 ? 'high' : escalation === 1 ? 'medium' : 'low';
      const outcome = await this.deps.runner.run({
        role: 'coder',
        prompt: this.buildCoderPrompt(project, task, ws.artifacts, prep),
        cwd: prep.cwd,
        logDir: ws.logs,
        taskId: task.id,
        projectId: project.id,
        addDirs: [ws.root],
        systemAppend: CODER_CONTRACT,
        minTier,
        onStuck: (info) => this.diagnoseStuckRun(project, task, info.logTail, ws.artifacts),
      });

      if (outcome.ok) {
        // Safety net: commit anything the agent left uncommitted.
        try {
          await commitAll(prep.cwd, `task(${task.planStepId ?? task.id}): ${task.title} (auto-commit)`);
        } catch {
          /* repo state issues surface in review */
        }
        updateTask(this.deps.db, this.deps.hub, task.id, { status: 'to_review' });
        await this.runReviewAndTestStages(project, task, ws.artifacts, prep.cwd);
        return;
      }

      // User-initiated kill (pause, delete, kill button): re-queue without
      // burning the retry budget. The task stays in backlog until resumed.
      if (outcome.finalRun?.status === 'killed') {
        const still = getTask(this.deps.db, task.id);
        if (still) updateTask(this.deps.db, this.deps.hub, task.id, { status: 'backlog' });
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

  /** Resume the remaining stages of a parked task (its worktree is reused,
   * or recreated from the project branch for pre-worktree tasks). */
  private async resumeStages(project: Project, task: Task, from: 'review' | 'test'): Promise<void> {
    const ws = workspacePaths(this.deps.workspacesDir, project.id);
    const prep = await this.prepareTaskWorktree(project, task);
    if ('error' in prep) return; // stay parked; surfaced on the next manual look
    await this.runReviewAndTestStages(project, task, ws.artifacts, prep.cwd, from);
  }

  private async runReviewAndTestStages(
    project: Project,
    task: Task,
    artifactsDir: string,
    cwd: string,
    from: 'review' | 'test' = 'review',
  ): Promise<void> {
    const settings = this.deps.settings.get();

    if (from === 'test') {
      await this.runTestStage(project, task, artifactsDir, cwd, settings);
      return;
    }

    // Review stage (skipped -> stays in to_review for manual handling).
    if (!settings.autoAdvanceReview || !this.deps.registry.pickForRole('reviewer')) return;

    const reviewPath = path.join(artifactsDir, `review-${task.id}.json`);
    const review = await this.runVerdictAgent({
      project,
      task,
      cwd,
      role: 'reviewer',
      contract: REVIEWER_CONTRACT,
      filePath: reviewPath,
      schema: ReviewVerdict,
      promptIntro: `Review the work for this task. Write your verdict JSON to: ${reviewPath}`,
    });
    // No verdict (reviewer crashed or timed out): bounce rather than leaving it
    // parked to be relaunched on a loop. Falls through to maxBounces -> failed.
    if (!review) {
      await this.bounce(
        project,
        task,
        'Automated review did not complete (the reviewer timed out or crashed). ' +
          'Make sure the change is small, self-contained, and the repo is in a clean, reviewable state.',
      );
      return;
    }

    if (review.verdict === 'changes_requested') {
      await this.bounce(project, task, `Review requested changes: ${review.notes}`);
      return;
    }
    updateTask(this.deps.db, this.deps.hub, task.id, { status: 'to_test' });
    await this.runTestStage(project, task, artifactsDir, cwd, settings);
  }

  private async runTestStage(
    project: Project,
    task: Task,
    artifactsDir: string,
    cwd: string,
    settings: ReturnType<SettingsStore['get']>,
  ): Promise<void> {
    // Test stage (skipped -> stays in to_test for manual handling).
    if (!settings.autoAdvanceTest || !this.deps.registry.pickForRole('tester')) return;

    const reportPath = path.join(artifactsDir, `test-report-${task.id}.json`);
    const report = await this.runVerdictAgent({
      project,
      task,
      cwd,
      role: 'tester',
      contract: TESTER_CONTRACT,
      filePath: reportPath,
      schema: TestVerdict,
      promptIntro: `Verify this task's implementation works. Write your report JSON to: ${reportPath}`,
    });
    // No verdict (the tester crashed or timed out) — don't leave it parked to
    // be relaunched forever. Treat it as a failed verification and bounce to
    // the coder; a timeout usually means the page/CLI hangs or errors badly.
    if (!report) {
      await this.bounce(
        project,
        task,
        'Automated verification did not complete (the tester timed out or crashed). ' +
          'This usually means the result hangs, crashes, or has a runtime/render error that ' +
          'prevents it from working — re-check it runs cleanly (inspect the browser console / run output).',
      );
      return;
    }

    if (!report.pass) {
      await this.bounce(project, task, `Tests failed: ${report.summary}`);
      return;
    }
    // A claimed pass must be backed by evidence that actually exists — the
    // tester cannot fake screenshot verification.
    const evidenceProblem = this.checkTestEvidence(task, report.evidence ?? [], cwd, artifactsDir);
    if (evidenceProblem) {
      await this.bounce(project, task, `Test verification rejected: ${evidenceProblem}`);
      return;
    }
    updateTask(this.deps.db, this.deps.hub, task.id, { status: 'done' });
  }

  /**
   * Guard against fabricated verification: every screenshot the tester cites
   * must exist on disk, and a task with a visual/rendering criterion must cite
   * at least one. Returns a problem string, or null if the evidence holds up.
   */
  private checkTestEvidence(
    task: Task,
    evidence: string[],
    cwd: string,
    artifactsDir: string,
  ): string | null {
    for (const p of evidence) {
      const candidates = path.isAbsolute(p)
        ? [p]
        : [path.resolve(cwd, p), path.resolve(artifactsDir, p), path.join(artifactsDir, path.basename(p))];
      if (!candidates.some((c) => fs.existsSync(c))) {
        return `claimed screenshot evidence not found on disk: ${p}`;
      }
    }
    // Only the acceptance CRITERIA decide whether a screenshot is required — the
    // planner writes screenshot language into genuinely visual steps. Keying on
    // the prose description would false-positive on scaffolding/backend tasks
    // that merely mention rendering ("do NOT implement render logic", "the
    // reporter will screenshot this later"), trapping them in a bounce loop.
    const criteriaText = task.acceptanceCriteria.join('\n');
    if (VISUAL_CRITERION_RE.test(criteriaText) && evidence.length === 0) {
      return 'an acceptance criterion requires visual verification but the tester provided no screenshot evidence';
    }
    return null;
  }

  /** Shared reviewer/tester execution: run agent, read + validate verdict file. */
  private async runVerdictAgent<T>(opts: {
    project: Project;
    task: Task;
    cwd: string;
    role: 'reviewer' | 'tester';
    contract: string;
    filePath: string;
    schema: z.ZodType<T>;
    promptIntro: string;
  }): Promise<T | null> {
    const ws = workspacePaths(this.deps.workspacesDir, opts.project.id);
    try {
      const outcome = await this.deps.runner.run({
        role: opts.role,
        prompt: `${opts.promptIntro}

# Task that was implemented: ${opts.task.title}

${opts.task.description}

## Acceptance criteria
${opts.task.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '- (none)'}

## Context
- You are in the task's isolated worktree; its branch contains the work.
- Commits for this task use the prefix: task(${opts.task.planStepId ?? opts.task.id})
- The base branch (for diffing) is: ${opts.project.gitBranch}`,
        cwd: opts.cwd,
        logDir: ws.logs,
        taskId: opts.task.id,
        projectId: opts.project.id,
        addDirs: [ws.root],
        systemAppend: opts.contract,
        // A verdict (review/test) should be quick. Cap it well under the
        // project wall clock so a rabbit-holing agent fails fast instead of
        // burning an hour and producing no verdict.
        timeouts: { stuckMs: 5 * 60_000, wallClockMs: 20 * 60_000 },
      });
      if (!outcome.ok) return null;
      return opts.schema.parse(JSON.parse(fs.readFileSync(opts.filePath, 'utf8')));
    } catch {
      return null;
    } finally {
      // Reviewers/testers must not commit; scrub any scratch/debug files they
      // left in the worktree so they don't get swept into the next coder commit.
      await discardUncommitted(opts.cwd).catch(() => {});
    }
  }

  /** Send a task back to the coder with stage feedback, bounded by maxBounces. */
  private async bounce(project: Project, task: Task, feedback: string): Promise<void> {
    const fresh = getTask(this.deps.db, task.id)!;
    const maxBounces = this.deps.settings.get().maxBounces;
    fs.writeFileSync(
      path.join(
        workspacePaths(this.deps.workspacesDir, project.id).artifacts,
        `feedback-${task.id}.md`,
      ),
      feedback,
    );
    if (fresh.bounceCount < maxBounces) {
      updateTask(this.deps.db, this.deps.hub, task.id, {
        status: 'backlog',
        bounceCount: fresh.bounceCount + 1,
      });
      this.nudge();
    } else {
      updateTask(this.deps.db, this.deps.hub, task.id, { status: 'failed' });
      await this.deps.notifier.notify(
        'task_failed',
        `Task failed review/test: ${task.title}`,
        `Bounced ${maxBounces} times. Last feedback: ${feedback.slice(0, 500)}`,
        project.id,
      );
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

  private buildCoderPrompt(
    project: Project,
    task: Task,
    artifactsDir: string,
    prep: { cwd: string; branch: string; mergeConflict: boolean },
  ): string {
    const criteria = task.acceptanceCriteria.length
      ? task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
      : '- (none specified — use your judgement)';

    let bounceContext = '';
    if (task.bounceCount > 0) {
      try {
        const feedback = fs.readFileSync(path.join(artifactsDir, `feedback-${task.id}.md`), 'utf8');
        bounceContext = `\n## Review/test feedback on your previous implementation (round ${task.bounceCount})\n${feedback.slice(0, 3000)}\nAddress this feedback. The previous work is already committed on the branch — amend it with new commits.\n`;
      } catch {
        /* no feedback file */
      }
    }

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
${bounceContext}${retryContext}${
      prep.mergeConflict
        ? `\n## Merge in progress\nThe base branch was merged into your task branch and left CONFLICT MARKERS in the tree. Resolve all conflicts first (keep both sides' intent), commit the merge, then complete the task.\n`
        : ''
    }
## Working agreement
- You are working in an ISOLATED git worktree on branch: ${prep.branch} (already checked out — stay on it; other tasks run in parallel on their own branches and your work is merged automatically when done)
- Your worktree (your ONLY working directory): ${prep.cwd}
- Do ALL work — files, installs, builds, and every git command — inside that worktree. NEVER \`cd\` out of it. In particular NEVER touch the parent repository at ${project.targetRepoPath} — that is the user's checkout holding the \`main\` branch; committing there breaks everything. Your worktree shares its git history with that repo, so a stray \`cd\` + \`git commit\` would land on \`main\`.
- Prefer touching only the files this task is about — parallel tasks are merged with git.
- Commit message format: task(${task.planStepId ?? task.id}): <what you did>
- You may write progress notes to: ${artifactsDir}

Begin.`;
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
    // Free the agent branch and build the report (both run in the background;
    // the status flip above already prevents this project from being re-evaluated).
    void this.finalizeProject(updated);
    void this.deps.notifier.notify(
      'project_done',
      `🎉 项目完成: ${project.name.slice(0, 60)}`,
      `成果在 ${project.targetRepoPath} 的 ${project.gitBranch} 分支。打开项目页查看完成报告(做了什么/如何运行)。`,
      project.id,
    );
  }

  /**
   * Post-completion housekeeping. Remove the integration worktree that held the
   * agent branch (freeing it), then for repos we created merge the agent branch
   * straight into the default branch so the result lands on main with no manual
   * checkout. Finally start a hosted live preview and build the report.
   */
  private async finalizeProject(project: Project): Promise<void> {
    const integration = this.integrationDir(project);
    if (fs.existsSync(integration)) {
      await removeWorktree(project.targetRepoPath, integration).catch(() => {});
    }

    let merged = project;
    if (project.freshRepo && project.gitBranch) {
      const target = await defaultBranch(project.targetRepoPath).catch(() => 'main');
      const result = await mergeBranchInto(
        project.targetRepoPath,
        target,
        project.gitBranch,
      ).catch(() => 'error' as const);
      if (result === 'ok') {
        this.deps.db
          .update(schema.projects)
          .set({ gitBranch: target })
          .where(eq(schema.projects.id, project.id))
          .run();
        merged = { ...project, gitBranch: target };
        this.deps.hub.publish('global', { type: 'project.updated', project: merged });
      }
      // conflict/error: leave the work on the agent branch; the report still
      // documents how to check it out.
    }

    // Host a live preview (best-effort; updates project.liveUrl when ready).
    void this.deps.projectRunner.start(merged).catch(() => {});

    try {
      this.deps.reports.ensure(merged);
    } catch {
      /* report regenerates on first view */
    }
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
