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

  /** Re-queue a failed/blocked/interrupted task for another attempt. */
  app.post('/api/tasks/:id/retry', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const task = getTask(ctx.db, id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const active = ctx.runStore.listByTask(id).some((r) => r.status === 'running');
    if (active) return reply.code(409).send({ error: 'task has an active agent — kill it first' });
    const updated = updateTask(ctx.db, ctx.hub, id, { status: 'backlog', blockedReason: null });
    ctx.orchestrator.nudge();
    return updated;
  });
}
