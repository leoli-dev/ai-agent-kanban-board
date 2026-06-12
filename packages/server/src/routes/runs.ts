import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function runRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
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
