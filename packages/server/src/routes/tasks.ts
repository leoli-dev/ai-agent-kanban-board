import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { TASK_STATUSES } from '@akb/shared';
import { schema } from '../db/index.js';
import { getTask, updateTask } from '../db/task-store.js';
import { toTask } from '../db/mappers.js';
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
    return updateTask(ctx.db, ctx.hub, id, { status: body.status, blockedReason: null });
  });
}
