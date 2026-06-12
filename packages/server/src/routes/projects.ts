import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { InputKind } from '@akb/shared';
import { schema } from '../db/index.js';
import { toPlanDocument, toProject, toProjectInput } from '../db/mappers.js';
import type { AppContext } from '../context.js';
import { initRepoWithBaseline, pruneWorktrees } from '../workspace/git.js';
import { scaffoldWorkspace, slugify, workspacePaths } from '../workspace/workspace.js';

const CreateProjectBody = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1),
  targetRepoPath: z.string().min(1),
  links: z.array(z.string().url()).default([]),
});

function classifyKind(filename: string, mime: string | undefined): InputKind {
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('video/')) return 'video';
  if (mime === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) return 'pdf';
  if (/\.(md|markdown)$/i.test(filename)) return 'markdown';
  return 'file';
}

export async function projectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/projects', async () => {
    const rows = ctx.db
      .select()
      .from(schema.projects)
      .orderBy(desc(schema.projects.createdAt))
      .all();
    return rows.map(toProject);
  });

  app.post('/api/projects', async (req, reply) => {
    const body = CreateProjectBody.parse(req.body);

    const repoPath = path.resolve(body.targetRepoPath.replace(/^~/, process.env.HOME ?? '~'));
    if (fs.existsSync(repoPath) && !fs.statSync(repoPath).isDirectory()) {
      return reply.code(400).send({ error: `target path is a file, not a directory: ${repoPath}` });
    }

    const id = nanoid(10);
    const name = body.name?.trim() || body.prompt.split(/\s+/).slice(0, 6).join(' ');

    // New projects often start from nothing: create the folder and init git
    // (with a baseline commit) instead of rejecting.
    try {
      fs.mkdirSync(repoPath, { recursive: true });
      await initRepoWithBaseline(repoPath, name);
    } catch (err) {
      return reply.code(400).send({ error: `could not prepare git repository: ${String(err)}` });
    }
    const paths = scaffoldWorkspace(ctx.workspacesDir, id);

    ctx.db
      .insert(schema.projects)
      .values({
        id,
        name,
        prompt: body.prompt,
        status: 'draft',
        workspacePath: paths.root,
        targetRepoPath: repoPath,
        gitBranch: `agent/${slugify(name)}-${id.slice(0, 4).toLowerCase()}`,
        createdAt: Date.now(),
      })
      .run();

    if (body.links.length) {
      fs.writeFileSync(path.join(paths.inputs, 'links.txt'), body.links.join('\n') + '\n');
      for (const url of body.links) {
        ctx.db
          .insert(schema.projectInputs)
          .values({ id: nanoid(10), projectId: id, kind: 'link', pathOrUrl: url })
          .run();
      }
    }

    const project = toProject(
      ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!,
    );
    ctx.hub.publish('global', { type: 'project.updated', project });
    reply.code(201);
    return project;
  });

  /** Final report for completed projects (deterministic part is instant;
   * the how-to-run section is agent-written and fills in shortly after). */
  app.get('/api/projects/:id/report', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'project not found' });
    if (row.status !== 'done') return { md: null };
    return { md: ctx.reports.ensure(toProject(row)) };
  });

  app.get('/api/projects/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'project not found' });
    const inputs = ctx.db
      .select()
      .from(schema.projectInputs)
      .where(eq(schema.projectInputs.projectId, id))
      .all()
      .map(toProjectInput);
    const plans = ctx.db
      .select()
      .from(schema.planDocuments)
      .where(eq(schema.planDocuments.projectId, id))
      .orderBy(desc(schema.planDocuments.version))
      .all()
      .map(toPlanDocument);
    return { ...toProject(row), inputs, plans };
  });

  /** Pause/resume: a paused project is skipped by the orchestrator; running
   * agents are killed on pause and their tasks re-queued. */
  app.post('/api/projects/:id/pause', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'project not found' });
    if (row.status !== 'running') return reply.code(409).send({ error: 'project is not running' });
    for (const run of ctx.runStore.listByProject(id)) {
      if (run.status === 'running') ctx.runner.kill(run.id);
    }
    ctx.db.update(schema.projects).set({ status: 'paused' }).where(eq(schema.projects.id, id)).run();
    const project = toProject(ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!);
    ctx.hub.publish('global', { type: 'project.updated', project });
    ctx.hub.publish(`board:${id}`, { type: 'project.updated', project });
    return project;
  });

  app.post('/api/projects/:id/resume', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'project not found' });
    if (row.status !== 'paused') return reply.code(409).send({ error: 'project is not paused' });
    ctx.db.update(schema.projects).set({ status: 'running' }).where(eq(schema.projects.id, id)).run();
    const project = toProject(ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!);
    ctx.hub.publish('global', { type: 'project.updated', project });
    ctx.hub.publish(`board:${id}`, { type: 'project.updated', project });
    ctx.orchestrator.nudge();
    return project;
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'project not found' });
    for (const run of ctx.runStore.listByProject(id)) {
      if (run.status === 'running') ctx.runner.kill(run.id);
    }
    ctx.db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
    ctx.db.delete(schema.projectInputs).where(eq(schema.projectInputs.projectId, id)).run();
    ctx.db.delete(schema.tasks).where(eq(schema.tasks.projectId, id)).run();
    ctx.db.delete(schema.planDocuments).where(eq(schema.planDocuments.projectId, id)).run();
    ctx.db.delete(schema.plannerSessions).where(eq(schema.plannerSessions.projectId, id)).run();
    fs.rmSync(row.workspacePath, { recursive: true, force: true });
    // Worktree dirs lived inside the workspace; drop their stale registrations.
    await pruneWorktrees(row.targetRepoPath).catch(() => {});
    reply.code(204);
  });

  /** Multipart file uploads into the project workspace. */
  app.post('/api/projects/:id/inputs', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = ctx.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'project not found' });

    const paths = workspacePaths(ctx.workspacesDir, id);
    const saved = [];
    for await (const part of req.files()) {
      const safeName = `${Date.now()}-${path.basename(part.filename).replace(/[^\w.\-]+/g, '_')}`;
      const dest = path.join(paths.inputs, safeName);
      await pipeline(part.file, fs.createWriteStream(dest));
      const inputId = nanoid(10);
      ctx.db
        .insert(schema.projectInputs)
        .values({
          id: inputId,
          projectId: id,
          kind: classifyKind(part.filename, part.mimetype),
          pathOrUrl: dest,
          originalName: part.filename,
          mime: part.mimetype,
          size: fs.statSync(dest).size,
        })
        .run();
      saved.push(
        toProjectInput(
          ctx.db
            .select()
            .from(schema.projectInputs)
            .where(eq(schema.projectInputs.id, inputId))
            .get()!,
        ),
      );
    }
    reply.code(201);
    return saved;
  });

  /** Serve an uploaded input file (image previews etc.). */
  app.get('/api/inputs/:inputId/file', async (req, reply) => {
    const inputId = (req.params as { inputId: string }).inputId;
    const row = ctx.db
      .select()
      .from(schema.projectInputs)
      .where(eq(schema.projectInputs.id, inputId))
      .get();
    if (!row || row.kind === 'link' || !fs.existsSync(row.pathOrUrl)) {
      return reply.code(404).send({ error: 'input not found' });
    }
    if (row.mime) reply.type(row.mime);
    return reply.send(fs.createReadStream(row.pathOrUrl));
  });
}
