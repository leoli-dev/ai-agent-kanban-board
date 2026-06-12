import fs from 'node:fs';
import { inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '../db/index.js';
import type { AppContext } from '../context.js';

export async function runRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * Central run ledger: every attempt ever made (success, failure, fallback,
   * kill), enriched with model/task/project names, plus per-model aggregates.
   */
  app.get('/api/activity', async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 150), 500);
    const runs = ctx.runStore.listRecent(limit);

    const profiles = new Map(ctx.registry.list().map((p) => [p.id, p]));
    const taskIds = [...new Set(runs.map((r) => r.taskId).filter((x): x is string => !!x))];
    const projectIds = [...new Set(runs.map((r) => r.projectId).filter((x): x is string => !!x))];
    const taskTitles = new Map(
      taskIds.length
        ? ctx.db
            .select({ id: schema.tasks.id, title: schema.tasks.title })
            .from(schema.tasks)
            .where(inArray(schema.tasks.id, taskIds))
            .all()
            .map((t) => [t.id, t.title])
        : [],
    );
    const projectNames = new Map(
      projectIds.length
        ? ctx.db
            .select({ id: schema.projects.id, name: schema.projects.name })
            .from(schema.projects)
            .where(inArray(schema.projects.id, projectIds))
            .all()
            .map((p) => [p.id, p.name])
        : [],
    );

    const enriched = runs.map((r) => {
      const profile = profiles.get(r.providerProfileId);
      return {
        ...r,
        providerName: profile?.name ?? r.providerProfileId,
        modelLabel: profile?.modelLabel ?? null,
        taskTitle: r.taskId ? (taskTitles.get(r.taskId) ?? null) : null,
        projectName: r.projectId ? (projectNames.get(r.projectId) ?? null) : null,
      };
    });

    const byProvider = ctx.db
      .select({
        providerProfileId: schema.agentRuns.providerProfileId,
        runs: sql<number>`count(*)`,
        failed: sql<number>`sum(case when status in ('failed','stuck','killed') then 1 else 0 end)`,
        inputTokens: sql<number>`coalesce(sum(input_tokens), 0)`,
        outputTokens: sql<number>`coalesce(sum(output_tokens), 0)`,
        costUsd: sql<number>`coalesce(sum(cost_usd), 0)`,
      })
      .from(schema.agentRuns)
      .groupBy(schema.agentRuns.providerProfileId)
      .all()
      .map((row) => ({
        ...row,
        providerName: profiles.get(row.providerProfileId)?.name ?? row.providerProfileId,
        modelLabel: profiles.get(row.providerProfileId)?.modelLabel ?? null,
      }))
      .sort((a, b) => b.costUsd - a.costUsd);

    const totals = {
      runs: byProvider.reduce((s, p) => s + p.runs, 0),
      failed: byProvider.reduce((s, p) => s + p.failed, 0),
      costUsd: byProvider.reduce((s, p) => s + p.costUsd, 0),
    };

    return { runs: enriched, byProvider, totals };
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const run = ctx.runStore.get((req.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    return run;
  });

  /** Raw NDJSON log tail (default last 64KB) for the log viewer. */
  app.get('/api/runs/:id/log', async (req, reply) => {
    const run = ctx.runStore.get((req.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const limit = Number((req.query as { bytes?: string }).bytes ?? 256 * 1024);
    try {
      const stat = fs.statSync(run.logPath);
      const start = Math.max(0, stat.size - limit);
      const stream = fs.createReadStream(run.logPath, { start });
      reply.type('application/x-ndjson');
      return reply.send(stream);
    } catch {
      reply.type('application/x-ndjson');
      return reply.send('');
    }
  });

  app.post('/api/runs/:id/kill', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const killed = ctx.runner.kill(id);
    if (!killed) return reply.code(409).send({ error: 'run is not active' });
    return { ok: true };
  });

  app.get('/api/tasks/:taskId/runs', async (req) =>
    ctx.runStore.listByTask((req.params as { taskId: string }).taskId),
  );

  app.get('/api/projects/:projectId/runs', async (req) =>
    ctx.runStore.listByProject((req.params as { projectId: string }).projectId),
  );
}
