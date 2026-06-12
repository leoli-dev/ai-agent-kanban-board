import { eq, inArray } from 'drizzle-orm';
import type { Task, TaskStatus } from '@akb/shared';
import { schema, type Db } from './index.js';
import { toTask } from './mappers.js';
import type { WsHub } from '../ws/hub.js';

export function getTask(db: Db, taskId: string): Task | null {
  const row = db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (!row) return null;
  const deps = db
    .select()
    .from(schema.taskDependencies)
    .where(eq(schema.taskDependencies.taskId, taskId))
    .all()
    .map((d) => d.dependsOnTaskId);
  return toTask(row, deps);
}

export function listProjectTasks(db: Db, projectId: string): Task[] {
  const rows = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, projectId))
    .orderBy(schema.tasks.orderIndex)
    .all();
  if (!rows.length) return [];
  const deps = db
    .select()
    .from(schema.taskDependencies)
    .where(
      inArray(
        schema.taskDependencies.taskId,
        rows.map((r) => r.id),
      ),
    )
    .all();
  return rows.map((r) =>
    toTask(
      r,
      deps.filter((d) => d.taskId === r.id).map((d) => d.dependsOnTaskId),
    ),
  );
}

export function updateTask(
  db: Db,
  hub: WsHub,
  taskId: string,
  patch: Partial<{
    status: TaskStatus;
    retryCount: number;
    bounceCount: number;
    blockedReason: string | null;
    description: string;
  }>,
): Task | null {
  db.update(schema.tasks)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(schema.tasks.id, taskId))
    .run();
  const task = getTask(db, taskId);
  if (task) {
    hub.publish(`board:${task.projectId}`, { type: 'task.updated', task });
    hub.publish('global', { type: 'task.updated', task });
  }
  return task;
}
