import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { schema } from '../src/db/index.js';
import { PlannerService } from '../src/agents/planner.js';
import { scaffoldWorkspace } from '../src/workspace/workspace.js';
import { addMockProfile, makeTestCtx, type MockScript, type TestCtx } from './helpers.js';

function makeProject(ctx: TestCtx): { projectId: string; ws: ReturnType<typeof scaffoldWorkspace> } {
  const projectId = nanoid(10);
  const ws = scaffoldWorkspace(ctx.tmpDir, projectId);
  ctx.db
    .insert(schema.projects)
    .values({
      id: projectId,
      name: 'Test project',
      prompt: 'Build a widget',
      status: 'draft',
      workspacePath: ws.root,
      targetRepoPath: ctx.tmpDir,
      createdAt: Date.now(),
    })
    .run();
  return { projectId, ws };
}

const sentinel = (text: string, files: { path: string; content: string }[]): MockScript => ({
  events: [
    { line: { type: 'system', subtype: 'init', session_id: `sess-${nanoid(6)}` } },
    {
      delayMs: 10,
      line: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: text,
        usage: { input_tokens: 10, output_tokens: 10 },
        total_cost_usd: 0.001,
        num_turns: 1,
      },
    },
  ],
  exitCode: 0,
  writeFiles: files,
});

const validPlan = {
  title: 'Widget',
  summary: 'Build the widget in two steps.',
  steps: [
    {
      id: 'step-1',
      title: 'Scaffold widget',
      description: 'Create widget module',
      acceptanceCriteria: ['module exists'],
      dependsOn: [],
    },
    {
      id: 'step-2',
      title: 'Test widget',
      description: 'Add tests',
      acceptanceCriteria: ['tests pass'],
      dependsOn: ['step-1'],
    },
  ],
};

describe('PlannerService', () => {
  it('full Q&A round trip: questions -> answers -> plan -> approve -> tasks', async () => {
    const ctx = makeTestCtx();
    const { projectId, ws } = makeProject(ctx);
    const planner = new PlannerService({
      db: ctx.db,
      hub: ctx.hub,
      runner: ctx.runner,
      settings: ctx.settings,
      workspacesDir: ctx.tmpDir,
    });

    const questionsFile = {
      questions: [{ id: 'q1', text: 'Which color?', options: ['red', 'blue'] }],
    };
    const phase1 = sentinel('I need more info.\nQUESTIONS_PENDING', [
      { path: path.join(ws.qa, 'questions-1.json'), content: JSON.stringify(questionsFile) },
    ]);
    const phase2 = sentinel('Plan written.\nPLAN_READY', [
      { path: path.join(ws.plan, 'plan.md'), content: '# Widget plan\n\nTwo steps.' },
      { path: path.join(ws.plan, 'plan.json'), content: JSON.stringify(validPlan) },
    ]);
    addMockProfile(ctx, 'planner', {
      events: [],
      // @ts-expect-error phases is a mock-cli extension
      phases: [phase1, phase2],
      stateFile: path.join(ctx.tmpDir, 'mock-state'),
    });

    await planner.start(projectId);

    let project = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    expect(project.status).toBe('awaiting_answers');
    const session = planner.latestSession(projectId)!;
    expect(session.qaRound).toBe(1);
    expect(session.engineSessionId).toMatch(/^sess-/);

    await planner.answer(projectId, [{ questionId: 'q1', answer: 'blue' }]);

    project = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    expect(project.status).toBe('awaiting_approval');
    const plans = ctx.db
      .select()
      .from(schema.planDocuments)
      .where(eq(schema.planDocuments.projectId, projectId))
      .all();
    expect(plans).toHaveLength(1);

    const { taskCount } = planner.approve(projectId);
    expect(taskCount).toBe(2);
    project = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    expect(project.status).toBe('running');

    const tasks = ctx.db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId)).all();
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.planStepId === 'step-1')!.orderIndex).toBe(0);
    const deps = ctx.db.select().from(schema.taskDependencies).all();
    expect(deps).toHaveLength(1);
  }, 20_000);

  it('plans directly without questions', async () => {
    const ctx = makeTestCtx();
    const { projectId, ws } = makeProject(ctx);
    const planner = new PlannerService({
      db: ctx.db,
      hub: ctx.hub,
      runner: ctx.runner,
      settings: ctx.settings,
      workspacesDir: ctx.tmpDir,
    });
    addMockProfile(
      ctx,
      'planner',
      sentinel('PLAN_READY', [
        { path: path.join(ws.plan, 'plan.md'), content: '# Plan' },
        { path: path.join(ws.plan, 'plan.json'), content: JSON.stringify(validPlan) },
      ]),
    );

    await planner.start(projectId);
    const project = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    expect(project.status).toBe('awaiting_approval');
  }, 20_000);

  it('fails the session when plan json is invalid after repair', async () => {
    const ctx = makeTestCtx();
    const { projectId, ws } = makeProject(ctx);
    const planner = new PlannerService({
      db: ctx.db,
      hub: ctx.hub,
      runner: ctx.runner,
      settings: ctx.settings,
      workspacesDir: ctx.tmpDir,
    });
    addMockProfile(
      ctx,
      'planner',
      sentinel('PLAN_READY', [
        { path: path.join(ws.plan, 'plan.md'), content: '# Plan' },
        { path: path.join(ws.plan, 'plan.json'), content: '{"not":"a plan"}' },
      ]),
    );

    await planner.start(projectId);
    const project = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    expect(project.status).toBe('draft');
    expect(planner.latestSession(projectId)!.status).toBe('failed');

    // Workspace plan files exist but no document row was created.
    expect(fs.existsSync(path.join(ws.plan, 'plan.json'))).toBe(true);
    const plans = ctx.db.select().from(schema.planDocuments).all();
    expect(plans).toHaveLength(0);
  }, 20_000);

  it('topo-sort rejects dependency cycles at approval', async () => {
    const ctx = makeTestCtx();
    const { projectId, ws } = makeProject(ctx);
    const planner = new PlannerService({
      db: ctx.db,
      hub: ctx.hub,
      runner: ctx.runner,
      settings: ctx.settings,
      workspacesDir: ctx.tmpDir,
    });
    const cyclic = {
      ...validPlan,
      steps: [
        { ...validPlan.steps[0]!, dependsOn: ['step-2'] },
        { ...validPlan.steps[1]!, dependsOn: ['step-1'] },
      ],
    };
    addMockProfile(
      ctx,
      'planner',
      sentinel('PLAN_READY', [
        { path: path.join(ws.plan, 'plan.md'), content: '# Plan' },
        { path: path.join(ws.plan, 'plan.json'), content: JSON.stringify(cyclic) },
      ]),
    );

    await planner.start(projectId);
    expect(() => planner.approve(projectId)).toThrow(/cycle/);
  }, 20_000);
});
