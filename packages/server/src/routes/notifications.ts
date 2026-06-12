import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function notificationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/notifications', async () => ctx.notifier.list());

  app.patch('/api/notifications/:id', async (req) => {
    const body = z.object({ read: z.boolean() }).parse(req.body);
    if (body.read) ctx.notifier.markRead((req.params as { id: string }).id);
    return { ok: true };
  });

  /** Send a test notification through all configured channels. */
  app.post('/api/notifications/test', async () =>
    ctx.notifier.notify('project_done', 'Test notification', 'All channels are working. 🎉'),
  );
}
