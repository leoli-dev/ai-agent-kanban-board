import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { providerRoutes } from './providers.js';
import { runRoutes } from './runs.js';
import { settingsRoutes } from './settings.js';
import { debugRoutes } from './debug.js';
import { projectRoutes } from './projects.js';
import { plannerRoutes } from './planner.js';
import { taskRoutes } from './tasks.js';
import { notificationRoutes } from './notifications.js';
import { modelRoutes } from './models.js';

export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await providerRoutes(app, ctx);
  await runRoutes(app, ctx);
  await settingsRoutes(app, ctx);
  await debugRoutes(app, ctx);
  await projectRoutes(app, ctx);
  await plannerRoutes(app, ctx);
  await taskRoutes(app, ctx);
  await notificationRoutes(app, ctx);
  await modelRoutes(app, ctx);
}
