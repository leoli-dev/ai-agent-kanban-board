import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AnswersFileSchema } from '@akb/shared';
import { schema } from '../db/index.js';
import { toPlannerMessage } from '../db/mappers.js';
import { listProjectTasks } from '../db/task-store.js';
import type { AppContext } from '../context.js';
import { workspacePaths } from '../workspace/workspace.js';

export async function plannerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/projects/:id/plan/start', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const project = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (!['draft', 'failed'].includes(project.status)) {
      return reply.code(409).send({ error: `cannot start planning from status "${project.status}"` });
    }
    if (!ctx.registry.pickForRole('planner')) {
      return reply
        .code(409)
        .send({ error: 'no provider configured for the planner role — set one up in Settings' });
    }
    void ctx.planner.start(id);
    return { ok: true };
  });

  app.post('/api/projects/:id/plan/answers', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = AnswersFileSchema.parse(req.body);
    const project = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (project.status !== 'awaiting_answers') {
      return reply.code(409).send({ error: 'no pending questions' });
    }
    void ctx.planner.answer(id, body.answers);
    return { ok: true };
  });

  app.post('/api/projects/:id/plan/approve', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const project = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (project.status !== 'awaiting_approval') {
      return reply.code(409).send({ error: 'no plan awaiting approval' });
    }
    try {
      const result = ctx.planner.approve(id);
      ctx.orchestrator.nudge();
      return result;
    } catch (err) {
      return reply.code(422).send({ error: `plan could not be converted to tasks: ${String(err)}` });
    }
  });

  app.post('/api/projects/:id/plan/reject', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ comment: z.string().min(1) }).parse(req.body);
    const project = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (project.status !== 'awaiting_approval') {
      return reply.code(409).send({ error: 'no plan awaiting approval' });
    }
    void ctx.planner.reject(id, body.comment);
    return { ok: true };
  });

  /** Latest plan content (markdown + parsed json), if any. */
  app.get('/api/projects/:id/plan', async (req) => {
    const id = (req.params as { id: string }).id;
    const ws = workspacePaths(ctx.workspacesDir, id);
    const mdPath = path.join(ws.plan, 'plan.md');
    const jsonPath = path.join(ws.plan, 'plan.json');
    return {
      md: fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : null,
      json: fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null,
    };
  });

  /** Planner session transcript for the chat UI. */
  app.get('/api/projects/:id/planner', async (req) => {
    const id = (req.params as { id: string }).id;
    const session = ctx.planner.latestSession(id);
    if (!session) return { session: null, messages: [] };
    const messages = ctx.db
      .select()
      .from(schema.plannerMessages)
      .where(eq(schema.plannerMessages.sessionId, session.id))
      .orderBy(schema.plannerMessages.createdAt)
      .all()
      .map(toPlannerMessage);
    return {
      session: {
        id: session.id,
        status: session.status,
        qaRound: session.qaRound,
        providerProfileId: session.providerProfileId,
      },
      messages,
    };
  });

  /** Tasks for a project (board + detail pages). */
  app.get('/api/projects/:id/tasks', async (req) =>
    listProjectTasks(ctx.db, (req.params as { id: string }).id),
  );
}
