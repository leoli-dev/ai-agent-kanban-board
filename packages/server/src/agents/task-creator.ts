import { and, eq, gt, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { PlanDocSchema, type PlanDoc, type Project, type SubtaskPlan, type Task } from '@akb/shared';
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

/**
 * Replace ONE task with the subtasks the planner split it into, rehanging the
 * surrounding DAG in place: the subtasks' internal dependsOn is honored, the
 * original task's external dependencies are inherited by the subtask roots, and
 * everything that depended on the original now depends on ALL subtasks (so a
 * dependent still waits for the whole unit). Atomic; emits task.deleted (the
 * original) + tasks.created (the subtasks). Throws on schema/cycle problems.
 */
export function decomposeTaskIntoSubtasks(
  db: Db,
  hub: WsHub,
  project: Project,
  original: Task,
  subPlan: SubtaskPlan,
  opts: { paused: boolean },
): Task[] {
  // Reuse the plan validator/topo-sort (rejects cycles + unknown dep ids).
  const ordered = topoSort({ title: 'decompose', summary: 'decompose', steps: subPlan.subtasks });

  const externalDeps = db
    .select()
    .from(schema.taskDependencies)
    .where(eq(schema.taskDependencies.taskId, original.id))
    .all()
    .map((d) => d.dependsOnTaskId);
  const dependents = db
    .select()
    .from(schema.taskDependencies)
    .where(eq(schema.taskDependencies.dependsOnTaskId, original.id))
    .all()
    .map((d) => d.taskId);

  const now = Date.now();
  const idByStep = new Map<string, string>(ordered.map((s) => [s.id, nanoid(10)]));
  const created: Task[] = [];

  db.transaction((tx) => {
    // Make room: shift tasks ordered after the original down by (n-1) so the
    // subtasks slot into the original's position in board order.
    const shift = ordered.length - 1;
    if (shift > 0) {
      tx.update(schema.tasks)
        .set({ orderIndex: sql`${schema.tasks.orderIndex} + ${shift}` })
        .where(
          and(
            eq(schema.tasks.projectId, project.id),
            gt(schema.tasks.orderIndex, original.orderIndex),
          ),
        )
        .run();
    }

    ordered.forEach((step, i) => {
      const id = idByStep.get(step.id)!;
      // Namespace the plan step id so task branches / commit prefixes stay unique.
      const planStepId = `${original.planStepId ?? original.id}.${step.id}`;
      tx.insert(schema.tasks)
        .values({
          id,
          projectId: project.id,
          planStepId,
          title: step.title,
          description: step.description,
          acceptanceCriteriaJson: JSON.stringify(step.acceptanceCriteria),
          status: 'backlog',
          orderIndex: original.orderIndex + i,
          paused: opts.paused ? 1 : 0,
          modelOverrideId: original.modelOverrideId,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const deps: string[] = [];
      // Internal edges between subtasks.
      for (const depStep of step.dependsOn) {
        const depId = idByStep.get(depStep);
        if (!depId) continue;
        tx.insert(schema.taskDependencies).values({ taskId: id, dependsOnTaskId: depId }).run();
        deps.push(depId);
      }
      // Roots (no internal dep) inherit the original task's external deps.
      if (step.dependsOn.length === 0) {
        for (const ext of externalDeps) {
          tx.insert(schema.taskDependencies).values({ taskId: id, dependsOnTaskId: ext }).run();
          deps.push(ext);
        }
      }
      created.push(
        toTask(tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!, deps),
      );
    });

    // Re-point everything that depended on the original onto all subtasks.
    for (const dependentId of dependents) {
      tx.delete(schema.taskDependencies)
        .where(
          and(
            eq(schema.taskDependencies.taskId, dependentId),
            eq(schema.taskDependencies.dependsOnTaskId, original.id),
          ),
        )
        .run();
      for (const newId of idByStep.values()) {
        tx.insert(schema.taskDependencies).values({ taskId: dependentId, dependsOnTaskId: newId }).run();
      }
    }

    // Drop the original task and every dependency row touching it.
    tx.delete(schema.tasks).where(eq(schema.tasks.id, original.id)).run();
    tx.delete(schema.taskDependencies)
      .where(
        or(
          eq(schema.taskDependencies.taskId, original.id),
          eq(schema.taskDependencies.dependsOnTaskId, original.id),
        ),
      )
      .run();
  });

  // Publish after commit so listeners never see a rolled-back state.
  hub.publish(`board:${project.id}`, { type: 'task.deleted', taskId: original.id, projectId: project.id });
  hub.publish('global', { type: 'task.deleted', taskId: original.id, projectId: project.id });
  hub.publish(`board:${project.id}`, { type: 'tasks.created', projectId: project.id, tasks: created });
  hub.publish('global', { type: 'tasks.created', projectId: project.id, tasks: created });
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
