import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AGENT_ROLES } from '@akb/shared';
import type { AppContext } from '../context.js';

/** Hidden debug endpoint: run an arbitrary prompt under a role. */
export async function debugRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/debug/run', async (req) => {
    const body = z
      .object({
        role: z.enum(AGENT_ROLES),
        prompt: z.string().min(1),
        cwd: z.string().min(1),
        profileId: z.string().optional(),
      })
      .parse(req.body);

    const outcome = await ctx.runner.run({
      role: body.role,
      prompt: body.prompt,
      cwd: body.cwd,
      profileId: body.profileId,
      logDir: path.join(ctx.dataDir, 'logs'),
    });
    return {
      ok: outcome.ok,
      failureClass: outcome.failureClass,
      blocked: outcome.blocked,
      runIds: outcome.attempts.map((a) => a.id),
      resultText: outcome.finalRun?.resultText ?? null,
      costUsd: outcome.finalRun?.costUsd ?? null,
    };
  });
}
