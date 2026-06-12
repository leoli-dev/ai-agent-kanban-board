import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

/** Route modules are registered here as phases land. */
export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  void ctx;
  void app;
}
