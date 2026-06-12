import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

const SettingsPatch = z
  .object({
    stuckThresholdMin: z.number().min(1).max(240),
    wallClockLimitMin: z.number().min(1).max(24 * 60),
    maxRetries: z.number().min(0).max(10),
    maxBounces: z.number().min(0).max(10),
    concurrency: z.number().min(1).max(4),
    maxQaRounds: z.number().min(1).max(20),
    autoAdvanceReview: z.boolean(),
    autoAdvanceTest: z.boolean(),
    notifyMacos: z.boolean(),
    notifyEmail: z.boolean(),
    smtp: z
      .object({
        host: z.string(),
        port: z.number(),
        secure: z.boolean(),
        user: z.string(),
        pass: z.string(),
        from: z.string(),
        to: z.string(),
      })
      .nullable(),
  })
  .partial();

export async function settingsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/settings', async () => ctx.settings.get());
  app.patch('/api/settings', async (req) => ctx.settings.update(SettingsPatch.parse(req.body)));
}
