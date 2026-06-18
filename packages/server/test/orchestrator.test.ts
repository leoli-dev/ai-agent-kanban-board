import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { schema } from '../src/db/index.js';
import { Notifier } from '../src/notify/notifier.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { ReportService } from '../src/reports/report-service.js';
import { ProjectRunner } from '../src/runner/project-runner.js';
import { updateTask } from '../src/db/task-store.js';
import { scaffoldWorkspace, workspacePaths } from '../src/workspace/workspace.js';
import { addMockProfile, makeTestCtx, scripts, type MockScript, type TestCtx } from './helpers.js';

function makeRepo(tmpDir: string): string {
  const repo = path.join(tmpDir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execSync(
    'git init -q && git config user.email t@t && git config user.name t && echo hi > README.md && git add -A && git commit -qm init',
    { cwd: repo },
  );
  return repo;
}

interface Fixture {
  ctx: TestCtx;
  orchestrator: Orchestrator;
  projectId: string;
  repo: string;
  artifacts: string;
}

function makeFixture(
  taskSpecs: { id: string; deps: string[]; description?: string; acceptanceCriteria?: string[] }[],
): Fixture {
  const ctx = makeTestCtx();
  const repo = makeRepo(ctx.tmpDir);
  const projectId = nanoid(10);
  const ws = scaffoldWorkspace(ctx.tmpDir, projectId);
  ctx.db
    .insert(schema.projects)
    .values({
      id: projectId,
      name: 'E2E project',
      prompt: 'Build things',
      status: 'running',
      workspacePath: ws.root,
      targetRepoPath: repo,
      gitBranch: 'agent/e2e',
      createdAt: Date.now(),
    })
    .run();

  const now = Date.now();
  taskSpecs.forEach((spec, i) => {
    ctx.db
      .insert(schema.tasks)
      .values({
        id: spec.id,
        projectId,
        planStepId: spec.id,
        title: `Task ${spec.id}`,
        description: spec.description ?? `Do ${spec.id}`,
        acceptanceCriteriaJson: JSON.stringify(spec.acceptanceCriteria ?? []),
        status: 'backlog',
        orderIndex: i,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    for (const dep of spec.deps) {
      ctx.db.insert(schema.taskDependencies).values({ taskId: spec.id, dependsOnTaskId: dep }).run();
    }
  });

  const notifier = new Notifier(ctx.db, ctx.hub, ctx.settings);
  const reports = new ReportService({
    db: ctx.db,
    runStore: ctx.runStore,
    registry: ctx.registry,
    runner: ctx.runner,
    workspacesDir: ctx.tmpDir,
  });
  const projectRunner = new ProjectRunner({ db: ctx.db, hub: ctx.hub, workspacesDir: ctx.tmpDir });
  const orchestrator = new Orchestrator({
    db: ctx.db,
    hub: ctx.hub,
    runner: ctx.runner,
    projectRunner,
    settings: ctx.settings,
    notifier,
    registry: ctx.registry,
    reports,
    workspacesDir: ctx.tmpDir,
  });
  return { ctx, orchestrator, projectId, repo, artifacts: ws.artifacts };
}

async function waitFor(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function taskStatus(ctx: TestCtx, id: string): string {
  return ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!.status;
}

const phased = (phases: MockScript[], stateFile: string): MockScript =>
  ({ events: [], phases, stateFile }) as unknown as MockScript;

describe('Orchestrator (money test)', () => {
  it('runs a 3-task plan sequentially with a mid-project quota fallback', async () => {
    const f = makeFixture([
      { id: 't1', deps: [] },
      { id: 't2', deps: ['t1'] },
      { id: 't3', deps: ['t2'] },
    ]);
    // Provider A: succeeds once, then hits quota. Provider B: always succeeds.
    const profileA = addMockProfile(
      f.ctx,
      'coder',
      phased([scripts.success('t1 done'), scripts.quota()], path.join(f.ctx.tmpDir, 'stateA')),
    );
    const profileB = addMockProfile(
      f.ctx,
      'coder',
      phased([scripts.success('done'), scripts.success('done')], path.join(f.ctx.tmpDir, 'stateB')),
    );

    f.orchestrator.start();
    await waitFor(() =>
      ['t1', 't2', 't3'].every((id) => taskStatus(f.ctx, id) === 'to_review'),
    );
    f.orchestrator.stop();

    // t2 fell back: provider A cooled down, both A and B have runs for t2.
    const cooled = f.ctx.registry.get(profileA.id)!;
    expect(cooled.cooldownUntil).toBeGreaterThan(Date.now());
    const t2Runs = f.ctx.runStore.listByTask('t2');
    expect(t2Runs.map((r) => r.providerProfileId).sort()).toEqual(
      [profileA.id, profileB.id].sort(),
    );
    // t3 skipped the cooled provider entirely.
    const t3Runs = f.ctx.runStore.listByTask('t3');
    expect(t3Runs).toHaveLength(1);
    expect(t3Runs[0]!.providerProfileId).toBe(profileB.id);

    // Tasks were executed in dependency order.
    const t1Run = f.ctx.runStore.listByTask('t1')[0]!;
    expect(t1Run.startedAt).toBeLessThanOrEqual(t2Runs[t2Runs.length - 1]!.startedAt);
  }, 30_000);

  it('completes the project and notifies when all tasks reach done', async () => {
    const f = makeFixture([{ id: 't1', deps: [] }]);
    addMockProfile(f.ctx, 'coder', scripts.success());

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'to_review');

    // Simulate the manual review/test pass (P6 automates this).
    updateTask(f.ctx.db, f.ctx.hub, 't1', { status: 'done' });
    f.orchestrator.nudge();

    await waitFor(
      () =>
        f.ctx.db.select().from(schema.projects).where(eq(schema.projects.id, f.projectId)).get()!
          .status === 'done',
    );
    f.orchestrator.stop();

    const notifications = f.ctx.db.select().from(schema.notifications).all();
    expect(notifications.some((n) => n.type === 'project_done')).toBe(true);
  }, 30_000);

  it('handles a stuck agent: debugger diagnosis, kill, retry, then success', async () => {
    const f = makeFixture([{ id: 't1', deps: [] }]);
    f.ctx.settings.update({ stuckThresholdMin: 0.005 }); // 300ms for the test
    addMockProfile(
      f.ctx,
      'coder',
      phased([scripts.stall(30_000), scripts.success('recovered')], path.join(f.ctx.tmpDir, 'stateS')),
    );
    addMockProfile(f.ctx, 'debugger', scripts.success('Likely cause: interactive prompt hang.'));

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'to_review', 25_000);
    f.orchestrator.stop();

    const task = f.ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, 't1')).get()!;
    expect(task.retryCount).toBe(1);

    const runs = f.ctx.runStore.listByTask('t1');
    expect(runs.some((r) => r.status === 'stuck')).toBe(true);
    expect(runs.some((r) => r.status === 'succeeded')).toBe(true);

    const diagnoses = fs.readdirSync(f.artifacts).filter((x) => x.startsWith('diagnosis-t1-'));
    expect(diagnoses).toHaveLength(1);
    expect(fs.readFileSync(path.join(f.artifacts, diagnoses[0]!), 'utf8')).toContain(
      'interactive prompt hang',
    );
  }, 30_000);

  it('runs the full auto pipeline: coder -> reviewer -> tester -> done', async () => {
    const f = makeFixture([{ id: 't1', deps: [] }]);
    addMockProfile(f.ctx, 'coder', scripts.success('implemented'));
    addMockProfile(
      f.ctx,
      'reviewer',
      scripts.success('REVIEW_DONE', {
        writeFiles: [
          {
            path: path.join(f.artifacts, 'review-t1.json'),
            content: JSON.stringify({ verdict: 'approve', notes: 'looks good' }),
          },
        ],
      }),
    );
    addMockProfile(
      f.ctx,
      'tester',
      scripts.success('TEST_DONE', {
        writeFiles: [
          {
            path: path.join(f.artifacts, 'test-report-t1.json'),
            content: JSON.stringify({ pass: true, summary: 'all tests pass' }),
          },
        ],
      }),
    );

    f.orchestrator.start();
    await waitFor(
      () =>
        f.ctx.db.select().from(schema.projects).where(eq(schema.projects.id, f.projectId)).get()!
          .status === 'done',
    );
    f.orchestrator.stop();

    expect(taskStatus(f.ctx, 't1')).toBe('done');
    const roles = f.ctx.runStore.listByTask('t1').map((r) => r.role).sort();
    expect(roles).toEqual(['coder', 'reviewer', 'tester']);
  }, 30_000);

  it('rejects a tester pass for a visual task with no screenshot evidence', async () => {
    const f = makeFixture([
      {
        id: 't1',
        deps: [],
        description: 'Build the dashboard page that renders a chart in the browser',
        acceptanceCriteria: ['Chart renders (verified by screenshot; placeholder does not pass)'],
      },
    ]);
    f.ctx.settings.update({ maxBounces: 0 }); // first rejection -> failed (no loop)
    addMockProfile(f.ctx, 'coder', scripts.success('implemented'));
    addMockProfile(
      f.ctx,
      'reviewer',
      scripts.success('REVIEW_DONE', {
        writeFiles: [
          { path: path.join(f.artifacts, 'review-t1.json'), content: JSON.stringify({ verdict: 'approve', notes: 'ok' }) },
        ],
      }),
    );
    addMockProfile(
      f.ctx,
      'tester',
      scripts.success('TEST_DONE', {
        writeFiles: [
          // Claims pass for a visual task but attaches no screenshot.
          { path: path.join(f.artifacts, 'test-report-t1.json'), content: JSON.stringify({ pass: true, summary: 'looks fine', evidence: [] }) },
        ],
      }),
    );

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'failed');
    f.orchestrator.stop();
    expect(taskStatus(f.ctx, 't1')).toBe('failed'); // guardrail blocked the unverified pass
  }, 30_000);

  it('rejects a tester pass that cites a screenshot file which does not exist', async () => {
    const f = makeFixture([
      { id: 't1', deps: [], description: 'Render the report page', acceptanceCriteria: ['page renders'] },
    ]);
    f.ctx.settings.update({ maxBounces: 0 });
    addMockProfile(f.ctx, 'coder', scripts.success('implemented'));
    addMockProfile(
      f.ctx,
      'reviewer',
      scripts.success('REVIEW_DONE', {
        writeFiles: [
          { path: path.join(f.artifacts, 'review-t1.json'), content: JSON.stringify({ verdict: 'approve', notes: 'ok' }) },
        ],
      }),
    );
    addMockProfile(
      f.ctx,
      'tester',
      scripts.success('TEST_DONE', {
        writeFiles: [
          {
            path: path.join(f.artifacts, 'test-report-t1.json'),
            content: JSON.stringify({ pass: true, summary: 'rendered', evidence: [path.join(f.artifacts, 'ghost.png')] }),
          },
        ],
      }),
    );

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'failed');
    f.orchestrator.stop();
    expect(taskStatus(f.ctx, 't1')).toBe('failed');
  }, 30_000);

  it('accepts a tester pass for a visual task backed by a real screenshot', async () => {
    const f = makeFixture([
      { id: 't1', deps: [], description: 'Render a chart', acceptanceCriteria: ['chart renders (screenshot)'] },
    ]);
    const shot = path.join(f.artifacts, 'shot-t1.png');
    addMockProfile(f.ctx, 'coder', scripts.success('implemented'));
    addMockProfile(
      f.ctx,
      'reviewer',
      scripts.success('REVIEW_DONE', {
        writeFiles: [
          { path: path.join(f.artifacts, 'review-t1.json'), content: JSON.stringify({ verdict: 'approve', notes: 'ok' }) },
        ],
      }),
    );
    addMockProfile(
      f.ctx,
      'tester',
      scripts.success('TEST_DONE', {
        writeFiles: [
          { path: shot, content: 'PNGDATA' }, // the screenshot the tester captured
          { path: path.join(f.artifacts, 'test-report-t1.json'), content: JSON.stringify({ pass: true, summary: 'renders', evidence: [shot] }) },
        ],
      }),
    );

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'done');
    f.orchestrator.stop();
    expect(taskStatus(f.ctx, 't1')).toBe('done');
  }, 30_000);

  it('accepts a visual pass with a real screenshot even if the tester over-cites a missing one', async () => {
    const f = makeFixture([
      { id: 't1', deps: [], description: 'Render a chart', acceptanceCriteria: ['chart renders (screenshot)'] },
    ]);
    const shot = path.join(f.artifacts, 'real-t1.png');
    const ghost = path.join(f.artifacts, 'never-saved.png');
    addMockProfile(f.ctx, 'coder', scripts.success('implemented'));
    addMockProfile(
      f.ctx,
      'reviewer',
      scripts.success('REVIEW_DONE', {
        writeFiles: [
          { path: path.join(f.artifacts, 'review-t1.json'), content: JSON.stringify({ verdict: 'approve', notes: 'ok' }) },
        ],
      }),
    );
    addMockProfile(
      f.ctx,
      'tester',
      scripts.success('TEST_DONE', {
        writeFiles: [
          { path: shot, content: 'PNGDATA' }, // one real screenshot saved
          {
            path: path.join(f.artifacts, 'test-report-t1.json'),
            // cites the real one AND a path it never wrote
            content: JSON.stringify({ pass: true, summary: 'renders', evidence: [shot, ghost] }),
          },
        ],
      }),
    );

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'done');
    f.orchestrator.stop();
    expect(taskStatus(f.ctx, 't1')).toBe('done');
  }, 30_000);

  it('accepts a visual pass whose screenshot the tester saved INSIDE the worktree (preserved before scrub)', async () => {
    // Regression: the tester saves evidence under its worktree, which is then
    // scrubbed (git clean) after the run. The cited path must still verify
    // because runVerdictAgent copies it into the project artifacts dir first.
    const f = makeFixture([
      { id: 't1', deps: [], description: 'Render a chart', acceptanceCriteria: ['chart renders (screenshot)'] },
    ]);
    // Where the tester drops the screenshot: inside its own task worktree.
    const worktreeShot = path.join(
      workspacePaths(f.ctx.tmpDir, f.projectId).root,
      'worktrees',
      't1',
      'artifacts',
      'inside-t1.png',
    );
    addMockProfile(f.ctx, 'coder', scripts.success('implemented'));
    addMockProfile(
      f.ctx,
      'reviewer',
      scripts.success('REVIEW_DONE', {
        writeFiles: [
          { path: path.join(f.artifacts, 'review-t1.json'), content: JSON.stringify({ verdict: 'approve', notes: 'ok' }) },
        ],
      }),
    );
    addMockProfile(
      f.ctx,
      'tester',
      scripts.success('TEST_DONE', {
        writeFiles: [
          { path: worktreeShot, content: 'PNGDATA' }, // saved inside the worktree (will be scrubbed)
          {
            path: path.join(f.artifacts, 'test-report-t1.json'),
            content: JSON.stringify({ pass: true, summary: 'renders', evidence: [worktreeShot] }),
          },
        ],
      }),
    );

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'done');
    f.orchestrator.stop();
    expect(taskStatus(f.ctx, 't1')).toBe('done');
    // The preserved, task-scoped copy lives in the project artifacts dir.
    expect(fs.existsSync(path.join(f.artifacts, 't1-inside-t1.png'))).toBe(true);
  }, 30_000);

  it('does not demand screenshots when only the description (not the criteria) mentions rendering', async () => {
    const f = makeFixture([
      {
        id: 't1',
        deps: [],
        // Scaffolding task that mentions render/screenshot/chart in passing — the
        // classic false-positive trap that should NOT require screenshot evidence.
        description: 'Scaffold the project. Do NOT implement render logic; the reporter will screenshot the chart later.',
        acceptanceCriteria: ['package.json is valid JSON with type=module', 'constants.js exports COMMON_PORTS'],
      },
    ]);
    addMockProfile(f.ctx, 'coder', scripts.success('scaffolded'));
    addMockProfile(
      f.ctx,
      'reviewer',
      scripts.success('REVIEW_DONE', {
        writeFiles: [
          { path: path.join(f.artifacts, 'review-t1.json'), content: JSON.stringify({ verdict: 'approve', notes: 'ok' }) },
        ],
      }),
    );
    addMockProfile(
      f.ctx,
      'tester',
      scripts.success('TEST_DONE', {
        writeFiles: [
          { path: path.join(f.artifacts, 'test-report-t1.json'), content: JSON.stringify({ pass: true, summary: 'files present', evidence: [] }) },
        ],
      }),
    );

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'done');
    f.orchestrator.stop();
    expect(taskStatus(f.ctx, 't1')).toBe('done'); // not bounced by the visual guardrail
  }, 30_000);

  it('bounces (does not loop) when the tester produces no verdict', async () => {
    const f = makeFixture([{ id: 't1', deps: [] }]);
    f.ctx.settings.update({ maxBounces: 0 }); // first bounce -> failed, proving no infinite loop
    addMockProfile(f.ctx, 'coder', scripts.success('implemented'));
    addMockProfile(
      f.ctx,
      'reviewer',
      scripts.success('REVIEW_DONE', {
        writeFiles: [
          { path: path.join(f.artifacts, 'review-t1.json'), content: JSON.stringify({ verdict: 'approve', notes: 'ok' }) },
        ],
      }),
    );
    addMockProfile(f.ctx, 'tester', scripts.crash()); // crashes without writing a verdict file

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'failed');
    f.orchestrator.stop();
    expect(taskStatus(f.ctx, 't1')).toBe('failed');
  }, 30_000);

  it('escalates the coder to a higher-tier model after a bounce', async () => {
    const f = makeFixture([{ id: 't1', deps: [] }]);
    f.ctx.settings.update({ maxBounces: 1, autoAdvanceTest: false });
    // Coder ladder by intelligence tier: low first, high reserved for escalation.
    const weak = addMockProfile(f.ctx, 'coder', scripts.success('weak attempt'), 'low');
    const strong = addMockProfile(f.ctx, 'coder', scripts.success('strong attempt'), 'high');
    // Reviewer always requests changes, so the task keeps bouncing.
    addMockProfile(
      f.ctx,
      'reviewer',
      scripts.success('REVIEW_DONE', {
        writeFiles: [
          { path: path.join(f.artifacts, 'review-t1.json'), content: JSON.stringify({ verdict: 'changes_requested', notes: 'fix it' }) },
        ],
      }),
    );

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'failed'); // one bounce, then fails at maxBounces=1
    f.orchestrator.stop();

    const coderRuns = f.ctx.runStore
      .listByTask('t1')
      .filter((r) => r.role === 'coder')
      .sort((a, b) => a.startedAt - b.startedAt);
    expect(coderRuns.length).toBe(2);
    expect(coderRuns[0]!.providerProfileId).toBe(weak.id); // first attempt: low tier
    expect(coderRuns[1]!.providerProfileId).toBe(strong.id); // escalated to high tier after the bounce
  }, 30_000);

  it('bounces a task back to the coder when review requests changes', async () => {
    const f = makeFixture([{ id: 't1', deps: [] }]);
    f.ctx.settings.update({ autoAdvanceTest: false });
    addMockProfile(f.ctx, 'coder', scripts.success('implemented'));
    addMockProfile(
      f.ctx,
      'reviewer',
      phased(
        [
          scripts.success('REVIEW_DONE', {
            writeFiles: [
              {
                path: path.join(f.artifacts, 'review-t1.json'),
                content: JSON.stringify({ verdict: 'changes_requested', notes: 'missing error handling' }),
              },
            ],
          }),
          scripts.success('REVIEW_DONE', {
            writeFiles: [
              {
                path: path.join(f.artifacts, 'review-t1.json'),
                content: JSON.stringify({ verdict: 'approve', notes: 'fixed' }),
              },
            ],
          }),
        ],
        path.join(f.ctx.tmpDir, 'stateR'),
      ),
    );

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'to_test');
    f.orchestrator.stop();

    const task = f.ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, 't1')).get()!;
    expect(task.bounceCount).toBe(1);
    expect(
      fs.readFileSync(path.join(f.artifacts, 'feedback-t1.md'), 'utf8'),
    ).toContain('missing error handling');
  }, 30_000);

  it('resumes a task parked in to_review (interrupted pipeline / late role config)', async () => {
    const f = makeFixture([{ id: 't1', deps: [] }]);
    // Simulate a pipeline interrupted after the coder finished.
    updateTask(f.ctx.db, f.ctx.hub, 't1', { status: 'to_review' });
    addMockProfile(
      f.ctx,
      'reviewer',
      scripts.success('REVIEW_DONE', {
        writeFiles: [
          {
            path: path.join(f.artifacts, 'review-t1.json'),
            content: JSON.stringify({ verdict: 'approve', notes: 'ok' }),
          },
        ],
      }),
    );
    addMockProfile(
      f.ctx,
      'tester',
      scripts.success('TEST_DONE', {
        writeFiles: [
          {
            path: path.join(f.artifacts, 'test-report-t1.json'),
            content: JSON.stringify({ pass: true, summary: 'works' }),
          },
        ],
      }),
    );

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'done');
    f.orchestrator.stop();

    const roles = f.ctx.runStore.listByTask('t1').map((r) => r.role).sort();
    expect(roles).toEqual(['reviewer', 'tester']);
  }, 30_000);

  it('fails a task after retries are exhausted and notifies', async () => {
    const f = makeFixture([{ id: 't1', deps: [] }]);
    f.ctx.settings.update({ maxRetries: 1 });
    addMockProfile(f.ctx, 'coder', scripts.taskFail());

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'failed');
    f.orchestrator.stop();

    const task = f.ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, 't1')).get()!;
    expect(task.retryCount).toBe(1);
    const notifications = f.ctx.db.select().from(schema.notifications).all();
    expect(notifications.some((n) => n.type === 'task_failed')).toBe(true);
  }, 30_000);

  it('wall-clock timeouts burn the retry budget and eventually fail (no endless loop)', async () => {
    // Regression: a wall-clock kill shares status 'killed' with a user kill, but
    // must NOT be treated as one — otherwise it re-queues for free forever,
    // looping ~every wall-clock window and never finishing or failing.
    const f = makeFixture([{ id: 't1', deps: [] }]);
    // Short wall clock (~600ms), comfortably under the stuck timer so the WALL
    // path fires (status 'killed'), not the stuck path (status 'stuck').
    f.ctx.settings.update({ maxRetries: 1, wallClockLimitMin: 0.01, stuckThresholdMin: 0.1 });
    addMockProfile(f.ctx, 'coder', scripts.stall());

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'failed');
    f.orchestrator.stop();

    const task = f.ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, 't1')).get()!;
    expect(task.retryCount).toBe(1); // the timeout consumed the budget
    const notifications = f.ctx.db.select().from(schema.notifications).all();
    expect(notifications.some((n) => n.type === 'task_failed')).toBe(true);
  }, 30_000);

  it('runs tasks in isolated worktrees — a dirty user checkout never blocks', async () => {
    const f = makeFixture([{ id: 't1', deps: [] }]);
    addMockProfile(f.ctx, 'coder', scripts.success());
    fs.writeFileSync(path.join(f.repo, 'dirty.txt'), 'uncommitted user work');

    f.orchestrator.start();
    await waitFor(() => taskStatus(f.ctx, 't1') === 'to_review');
    f.orchestrator.stop();

    // User's uncommitted file is untouched; agent worked in its own worktree.
    expect(fs.readFileSync(path.join(f.repo, 'dirty.txt'), 'utf8')).toContain('user work');
    expect(fs.existsSync(path.join(f.ctx.tmpDir, f.projectId, 'worktrees', 't1'))).toBe(true);
  }, 30_000);

  it('executes independent tasks in parallel and merges both into the project branch', async () => {
    const f = makeFixture([
      { id: 't1', deps: [] },
      { id: 't2', deps: [] },
    ]);
    f.ctx.settings.update({ concurrency: 2 });
    const wt = (taskId: string) => path.join(f.ctx.tmpDir, f.projectId, 'worktrees', taskId);
    // Launch order within one evaluate pass is t1 then t2 (orderIndex).
    // Slow the mocks down (500ms) so run windows demonstrably overlap.
    const slowSuccess = (text: string, file: string, content: string) => {
      const s = scripts.success(text, {
        writeFiles: [{ path: file, content }],
      });
      s.events[s.events.length - 1]!.delayMs = 500;
      return s;
    };
    addMockProfile(
      f.ctx,
      'coder',
      phased(
        [
          slowSuccess('t1 done', path.join(wt('t1'), 'frontend.txt'), 'ui'),
          slowSuccess('t2 done', path.join(wt('t2'), 'backend.txt'), 'api'),
        ],
        path.join(f.ctx.tmpDir, 'stateP'),
      ),
    );

    f.orchestrator.start();
    await waitFor(
      () => taskStatus(f.ctx, 't1') === 'to_review' && taskStatus(f.ctx, 't2') === 'to_review',
    );
    // Both coders ran concurrently (overlapping run windows).
    const r1 = f.ctx.runStore.listByTask('t1')[0]!;
    const r2 = f.ctx.runStore.listByTask('t2')[0]!;
    expect(r1.startedAt).toBeLessThan(r2.endedAt ?? Infinity);
    expect(r2.startedAt).toBeLessThan(r1.endedAt ?? Infinity);

    // Simulate manual review/test pass; integration merges both branches.
    updateTask(f.ctx.db, f.ctx.hub, 't1', { status: 'done' });
    updateTask(f.ctx.db, f.ctx.hub, 't2', { status: 'done' });
    f.orchestrator.nudge();
    await waitFor(
      () =>
        f.ctx.db.select().from(schema.projects).where(eq(schema.projects.id, f.projectId)).get()!
          .status === 'done',
    );
    f.orchestrator.stop();

    // Both files exist on the project branch.
    const show = (file: string) =>
      execSync(`git show agent/e2e:${file}`, { cwd: f.repo }).toString();
    expect(show('frontend.txt')).toBe('ui');
    expect(show('backend.txt')).toBe('api');
  }, 30_000);

  it('a dependent builds on its dependency’s committed work, even before the dependency is integrated', async () => {
    const f = makeFixture([
      { id: 't1', deps: [] },
      { id: 't2', deps: ['t1'] },
    ]);
    const wt = (taskId: string) => path.join(f.ctx.tmpDir, f.projectId, 'worktrees', taskId);
    addMockProfile(
      f.ctx,
      'coder',
      phased(
        [
          scripts.success('t1 done', {
            writeFiles: [{ path: path.join(wt('t1'), 'shared.txt'), content: 'from-t1' }],
          }),
          scripts.success('t2 done', {
            writeFiles: [{ path: path.join(wt('t2'), 't2.txt'), content: 'from-t2' }],
          }),
        ],
        path.join(f.ctx.tmpDir, 'stateDep'),
      ),
    );

    f.orchestrator.start();
    // No reviewer/tester configured: tasks park at to_review. t1 commits its
    // work on its own branch but is NOT integrated, yet t2 starts (deps are
    // satisfied at to_review) and must already see t1's file in its worktree.
    await waitFor(() => taskStatus(f.ctx, 't2') === 'to_review');
    f.orchestrator.stop();

    // t1 never integrated (still parked, worktree present), so the only way
    // t2's worktree contains shared.txt is the dependency-branch merge at prep.
    expect(taskStatus(f.ctx, 't1')).toBe('to_review');
    expect(fs.readFileSync(path.join(wt('t2'), 'shared.txt'), 'utf8')).toBe('from-t1');
  });
});
