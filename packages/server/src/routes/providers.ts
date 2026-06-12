import os from 'node:os';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AGENT_ROLES, ENGINES } from '@akb/shared';
import type { AppContext } from '../context.js';

const ProfileBody = z.object({
  name: z.string().min(1),
  engine: z.enum(ENGINES),
  env: z.record(z.string(), z.string()).default({}),
  modelLabel: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

export async function providerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/providers', async () => ctx.registry.list());

  app.post('/api/providers', async (req, reply) => {
    const body = ProfileBody.parse(req.body);
    reply.code(201);
    return ctx.registry.create(body);
  });

  app.patch('/api/providers/:id', async (req, reply) => {
    const body = ProfileBody.partial().parse(req.body);
    const updated = ctx.registry.update((req.params as { id: string }).id, body);
    if (!updated) return reply.code(404).send({ error: 'provider not found' });
    return updated;
  });

  app.delete('/api/providers/:id', async (req, reply) => {
    ctx.registry.delete((req.params as { id: string }).id);
    reply.code(204);
  });

  /** One-shot smoke test of a provider: ask it to reply OK, no tools needed. */
  app.post('/api/providers/:id/test', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const profile = ctx.registry.get(id);
    if (!profile) return reply.code(404).send({ error: 'provider not found' });
    const outcome = await ctx.runner.run({
      role: 'orchestrator',
      profileId: id,
      prompt: 'Reply with the single word OK. Do not use any tools.',
      cwd: os.tmpdir(),
      logDir: `${ctx.dataDir}/logs`,
      timeouts: { stuckMs: 120_000, wallClockMs: 180_000 },
    });
    return {
      ok: outcome.ok,
      failureClass: outcome.failureClass,
      resultText: outcome.finalRun?.resultText ?? null,
      costUsd: outcome.finalRun?.costUsd ?? null,
    };
  });

  /** Subscription/quota usage for a provider (best-effort, vendor-specific). */
  app.get('/api/providers/:id/usage', async (req, reply) => {
    const profile = ctx.registry.get((req.params as { id: string }).id);
    if (!profile) return reply.code(404).send({ error: 'provider not found' });
    return ctx.usage.forProfile(profile);
  });

  app.get('/api/roles', async () => {
    const all = ctx.registry.assignments();
    return AGENT_ROLES.map((role) => ({
      role,
      profileIds: all.filter((a) => a.role === role).map((a) => a.providerProfileId),
    }));
  });

  app.put('/api/roles/:role', async (req, reply) => {
    const role = (req.params as { role: string }).role;
    if (!(AGENT_ROLES as readonly string[]).includes(role)) {
      return reply.code(400).send({ error: `unknown role ${role}` });
    }
    const body = z.object({ profileIds: z.array(z.string()) }).parse(req.body);
    return ctx.registry.setRoleOrder(role as (typeof AGENT_ROLES)[number], body.profileIds);
  });

  app.get('/api/secrets', async () => ({ names: ctx.secrets.names() }));

  app.put('/api/secrets/:name', async (req) => {
    const name = (req.params as { name: string }).name;
    const body = z.object({ value: z.string().min(1) }).parse(req.body);
    ctx.secrets.set(name, body.value);
    return { ok: true };
  });

  app.delete('/api/secrets/:name', async (req, reply) => {
    ctx.secrets.delete((req.params as { name: string }).name);
    reply.code(204);
  });
}
