import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { PlanDocSchema, type PlanDoc, type Task } from '@akb/shared';
import { schema, type Db } from '../db/index.js';
import { toTask } from '../db/mappers.js';
import type { WsHub } from '../ws/hub.js';

/**
 * Deterministic plan.json -> kanban tasks conversion (no LLM): validates the
 * plan, topologically sorts steps, persists tasks + dependencies.
 * Throws on schema violations or dependency cycles; the caller may then use
 * the task-creator LLM role to repair the plan JSON and retry.
 */
export function createTasksFromPlan(
  db: Db,
  hub: WsHub,
  projectId: string,
  planJson: unknown,
): Task[] {
  const plan: PlanDoc = PlanDocSchema.parse(planJson);
  const order = topoSort(plan);
  const now = Date.now();

  const created: Task[] = [];
  for (const [index, step] of order.entries()) {
    const id = nanoid(10);
    db.insert(schema.tasks)
      .values({
        id,
        projectId,
        planStepId: step.id,
        title: step.title,
        description: step.description,
        acceptanceCriteriaJson: JSON.stringify(step.acceptanceCriteria),
        status: 'backlog',
        orderIndex: index,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    created.push(toTask(db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!, []));
  }

  // Map plan step ids -> task ids for dependency rows.
  const byStepId = new Map(created.map((t) => [t.planStepId!, t]));
  for (const step of plan.steps) {
    const task = byStepId.get(step.id)!;
    const deps: string[] = [];
    for (const depStepId of step.dependsOn) {
      const depTask = byStepId.get(depStepId);
      if (!depTask) continue; // tolerated: zod passed but id unknown
      db.insert(schema.taskDependencies)
        .values({ taskId: task.id, dependsOnTaskId: depTask.id })
        .run();
      deps.push(depTask.id);
    }
    task.dependsOn = deps;
  }

  hub.publish(`board:${projectId}`, { type: 'tasks.created', projectId, tasks: created });
  hub.publish('global', { type: 'tasks.created', projectId, tasks: created });
  return created;
}

/** Kahn's algorithm; throws on cycles or unknown dependsOn references. */
export function topoSort(plan: PlanDoc): PlanDoc['steps'] {
  const steps = plan.steps;
  const ids = new Set(steps.map((s) => s.id));
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(`step "${step.id}" depends on unknown step "${dep}"`);
      }
    }
  }

  const indegree = new Map<string, number>(steps.map((s) => [s.id, s.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), step.id]);
    }
  }

  const byId = new Map(steps.map((s) => [s.id, s]));
  // Stable: among ready steps keep plan order.
  const queue = steps.filter((s) => indegree.get(s.id) === 0).map((s) => s.id);
  const sorted: PlanDoc['steps'] = [];
  while (queue.length) {
    const id = queue.shift()!;
    sorted.push(byId.get(id)!);
    for (const next of dependents.get(id) ?? []) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (sorted.length !== steps.length) {
    throw new Error('plan steps contain a dependency cycle');
  }
  return sorted;
}
