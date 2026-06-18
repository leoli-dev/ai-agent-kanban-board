import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { TASK_STATUSES } from '@akb/shared';
import { schema } from '../db/index.js';
import { getTask, updateTask } from '../db/task-store.js';
import { toProject, toTask } from '../db/mappers.js';
import type { AppContext } from '../context.js';

export async function taskRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /** All tasks across projects (global board). */
  app.get('/api/tasks', async () => {
    const rows = ctx.db.select().from(schema.tasks).orderBy(schema.tasks.orderIndex).all();
    const deps = ctx.db.select().from(schema.taskDependencies).all();
    return rows.map((r) =>
      toTask(
        r,
        deps.filter((d) => d.taskId === r.id).map((d) => d.dependsOnTaskId),
      ),
    );
  });

  app.get('/api/tasks/:id', async (req, reply) => {
    const task = getTask(ctx.db, (req.params as { id: string }).id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    return task;
  });

  /** Manual move on the board (always allowed; overrides automation). */
  app.patch('/api/tasks/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z
      .object({ status: z.enum(TASK_STATUSES) })
      .parse(req.body);
    const existing = getTask(ctx.db, id);
    if (!existing) return reply.code(404).send({ error: 'task not found' });
    const updated = updateTask(ctx.db, ctx.hub, id, { status: body.status, blockedReason: null });
    ctx.orchestrator.nudge();
    return updated;
  });

  /** Stage artifacts for the summary view: review verdict, test report,
   * bounce feedback, debugger diagnoses. */
  app.get('/api/tasks/:id/artifacts', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const task = getTask(ctx.db, id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const project = ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, task.projectId))
      .get();
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const artifactsDir = path.join(project.workspacePath, 'artifacts');

    const readJson = (file: string): unknown => {
      try {
        return JSON.parse(fs.readFileSync(path.join(artifactsDir, file), 'utf8'));
      } catch {
        return null;
      }
    };
    const readText = (file: string): string | null => {
      try {
        return fs.readFileSync(path.join(artifactsDir, file), 'utf8');
      } catch {
        return null;
      }
    };
    let diagnoses: string[] = [];
    try {
      diagnoses = fs
        .readdirSync(artifactsDir)
        .filter((f) => f.startsWith(`diagnosis-${id}-`))
        .sort()
        .slice(-2)
        .map((f) => readText(f) ?? '')
        .filter(Boolean);
    } catch {
      /* no artifacts dir */
    }

    return {
      review: readJson(`review-${id}.json`),
      testReport: readJson(`test-report-${id}.json`),
      feedback: readText(`feedback-${id}.md`),
      diagnoses,
    };
  });

  /** Delete a task: kill its active agent first, then remove rows + deps. */
  app.delete('/api/tasks/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const task = getTask(ctx.db, id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    for (const run of ctx.runStore.listByTask(id)) {
      if (run.status === 'running') ctx.runner.kill(run.id);
    }
    const projectRow = ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, task.projectId))
      .get();
    if (projectRow) {
      void ctx.orchestrator.cleanupTaskWorktree(toProject(projectRow), task).catch(() => {});
    }
    ctx.db.delete(schema.tasks).where(eq(schema.tasks.id, id)).run();
    ctx.db.delete(schema.taskDependencies).where(eq(schema.taskDependencies.taskId, id)).run();
    // Tasks that depended on this one become unblocked by design.
    ctx.db
      .delete(schema.taskDependencies)
      .where(eq(schema.taskDependencies.dependsOnTaskId, id))
      .run();
    ctx.hub.publish(`board:${task.projectId}`, { type: 'task.deleted', taskId: id, projectId: task.projectId });
    ctx.hub.publish('global', { type: 'task.deleted', taskId: id, projectId: task.projectId });
    ctx.orchestrator.nudge();
    reply.code(204);
  });

  /**
   * Re-run a single task from scratch — CI "re-run failed job" style. Clears the
   * failed attempt's worktree, resets its bounce/retry budget so it gets a full
   * fresh attempt (not an instant re-fail), and resumes the project if it had
   * stopped, so the orchestrator picks the task up. Other tasks are untouched.
   */
  app.post('/api/tasks/:id/retry', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const task = getTask(ctx.db, id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const active = ctx.runStore.listByTask(id).some((r) => r.status === 'running');
    if (active) return reply.code(409).send({ error: 'task has an active agent — kill it first' });

    const projectRow = ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, task.projectId))
      .get();
    if (projectRow) {
      // Drop the failed attempt's worktree/branch so the redo starts clean and
      // re-bases on the latest integrated work.
      await ctx.orchestrator.cleanupTaskWorktree(toProject(projectRow), task).catch(() => {});
      // The orchestrator only advances 'running' projects — resume if it stopped
      // (e.g. it parked after this task failed) so the redo actually executes.
      if (['paused', 'failed', 'done'].includes(projectRow.status)) {
        ctx.db
          .update(schema.projects)
          .set({ status: 'running', completedAt: null })
          .where(eq(schema.projects.id, task.projectId))
          .run();
        const updatedProject = toProject(
          ctx.db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)).get()!,
        );
        ctx.hub.publish('global', { type: 'project.updated', project: updatedProject });
        ctx.hub.publish(`board:${task.projectId}`, { type: 'project.updated', project: updatedProject });
      }
    }

    const updated = updateTask(ctx.db, ctx.hub, id, {
      status: 'backlog',
      blockedReason: null,
      retryCount: 0,
      bounceCount: 0,
    });
    ctx.orchestrator.nudge();
    return updated;
  });

  /**
   * Pause a task: stop any running agent and hold the task so the orchestrator
   * won't pick it up. Used to step in when the current model is too slow — pause,
   * switch the model, then resume.
   */
  app.post('/api/tasks/:id/pause', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const task = getTask(ctx.db, id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    for (const run of ctx.runStore.listByTask(id)) {
      if (run.status === 'running') ctx.runner.kill(run.id);
    }
    // A killed wip task would otherwise re-queue to backlog and run again; mark
    // it paused (and idle) so it stays put until the user resumes.
    const updated = updateTask(ctx.db, ctx.hub, id, {
      paused: 1,
      ...(task.status === 'wip' ? { status: 'backlog' as const } : {}),
    });
    return updated;
  });

  /** Resume a paused task; ensure the project is running so it executes. */
  app.post('/api/tasks/:id/resume', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const task = getTask(ctx.db, id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const projectRow = ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, task.projectId))
      .get();
    if (projectRow && ['paused', 'failed', 'done'].includes(projectRow.status)) {
      ctx.db
        .update(schema.projects)
        .set({ status: 'running', completedAt: null })
        .where(eq(schema.projects.id, task.projectId))
        .run();
      const updatedProject = toProject(
        ctx.db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)).get()!,
      );
      ctx.hub.publish('global', { type: 'project.updated', project: updatedProject });
      ctx.hub.publish(`board:${task.projectId}`, { type: 'project.updated', project: updatedProject });
    }
    const updated = updateTask(ctx.db, ctx.hub, id, { paused: 0 });
    ctx.orchestrator.nudge();
    return updated;
  });

  /**
   * Re-decompose a task: send it back to the planner to be split into smaller
   * subtasks (created paused for review). Runs in the background — the UI reacts
   * to the resulting tasks.created / task.deleted / task.decompose_failed events.
   */
  app.post('/api/tasks/:id/decompose', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const task = getTask(ctx.db, id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    if (ctx.runStore.listByTask(id).some((r) => r.status === 'running')) {
      return reply.code(409).send({ error: 'task has an active agent — kill it first' });
    }
    if (task.status === 'done') {
      return reply.code(422).send({ error: 'cannot split a task that is already done' });
    }
    if (task.decomposing) {
      return reply.code(409).send({ error: 'this task is already being split' });
    }
    if (!ctx.registry.pickForRole('planner')) {
      return reply
        .code(409)
        .send({ error: 'no provider configured for the planner role — set one up in Settings' });
    }
    void ctx.orchestrator.decomposeTask(id);
    return { ok: true };
  });

  /**
   * Pin (or clear) the model for this task's coder runs. The override beats
   * role selection and escalation; null restores auto-by-role.
   */
  app.patch('/api/tasks/:id/model', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ profileId: z.string().nullable() }).parse(req.body);
    const task = getTask(ctx.db, id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    if (body.profileId && !ctx.registry.get(body.profileId)) {
      return reply.code(400).send({ error: 'unknown model profile' });
    }
    const updated = updateTask(ctx.db, ctx.hub, id, { modelOverrideId: body.profileId });
    return updated;
  });
}
