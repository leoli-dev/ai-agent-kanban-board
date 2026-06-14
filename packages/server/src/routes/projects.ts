import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { desc, eq, sql } from 'drizzle-orm';
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
  /** A single folder name; the full path is {defaultProjectDir}/{repoName}. */
  repoName: z.string().min(1),
  links: z.array(z.string().url()).default([]),
});

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(process.env.HOME ?? '~', p.slice(1)) : p;
}

/**
 * A short project name from the prompt's first line. Splitting on whitespace
 * fails for space-sparse text (e.g. Chinese), producing a name that is nearly
 * the whole idea — so cap by characters instead.
 */
function deriveProjectName(prompt: string, maxLen = 60): string {
  const firstLine = (prompt.split('\n').find((l) => l.trim()) ?? prompt).trim();
  if (firstLine.length <= maxLen) return firstLine || 'Untitled project';
  return firstLine.slice(0, maxLen - 1).trimEnd() + '…';
}

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

    // Per-project task status counts for the dashboard cards.
    const counts = ctx.db
      .select({
        projectId: schema.tasks.projectId,
        status: schema.tasks.status,
        n: sql<number>`count(*)`,
      })
      .from(schema.tasks)
      .groupBy(schema.tasks.projectId, schema.tasks.status)
      .all();
    const byProject = new Map<string, Record<string, number>>();
    for (const c of counts) {
      const m = byProject.get(c.projectId) ?? {};
      m[c.status] = c.n;
      byProject.set(c.projectId, m);
    }

    return rows.map((row) => {
      const project = toProject(row);
      const m = byProject.get(project.id) ?? {};
      const total = Object.values(m).reduce((s, n) => s + n, 0);
      const done = m.done ?? 0;
      const failed = m.failed ?? 0;
      const blocked = m.blocked ?? 0;
      const inFlight = (m.wip ?? 0) + (m.to_review ?? 0) + (m.to_test ?? 0);
      const percent =
        project.status === 'done' ? 100 : total > 0 ? Math.round((done / total) * 100) : 0;
      const needsAttention =
        project.status === 'awaiting_answers'
          ? 'answers'
          : project.status === 'awaiting_approval'
            ? 'approval'
            : blocked > 0
              ? 'blocked'
              : failed > 0 && project.status !== 'done'
                ? 'failed'
                : null;
      return {
        ...project,
        stats: { total, done, failed, blocked, inFlight, percent },
        needsAttention,
        runtimeMs: (project.completedAt ?? Date.now()) - project.createdAt,
      };
    });
  });

  app.post('/api/projects', async (req, reply) => {
    const body = CreateProjectBody.parse(req.body);

    // The repo name must be a single folder segment confined to the configured
    // default project dir — no slashes, no traversal, no escaping the base.
    const repoName = body.repoName.trim();
    if (
      !repoName ||
      repoName === '.' ||
      repoName === '..' ||
      repoName.includes('/') ||
      repoName.includes('\\') ||
      repoName.includes('..')
    ) {
      return reply
        .code(400)
        .send({ error: 'repo name must be a single folder name (no "/", "\\", or "..")' });
    }
    const baseDir = path.resolve(expandHome(ctx.settings.get().defaultProjectDir));
    const repoPath = path.join(baseDir, repoName);
    // Defense in depth: the resolved path must stay inside baseDir.
    const rel = path.relative(baseDir, repoPath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return reply.code(400).send({ error: 'target path escapes the default project folder' });
    }
    if (fs.existsSync(repoPath) && !fs.statSync(repoPath).isDirectory()) {
      return reply.code(400).send({ error: `target path is a file, not a directory: ${repoPath}` });
    }

    const id = nanoid(10);
    const name = body.name?.trim() || deriveProjectName(body.prompt);

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
    if (!row || row.kind === 'link') {
      return reply.code(404).send({ error: 'input not found' });
    }
    // Stored paths are absolute; if the workspace dir moved (e.g. the repo was
    // renamed) fall back to the file's current location by basename.
    let filePath = row.pathOrUrl;
    if (!fs.existsSync(filePath)) {
      filePath = path.join(workspacePaths(ctx.workspacesDir, row.projectId).inputs, path.basename(row.pathOrUrl));
      if (!fs.existsSync(filePath)) return reply.code(404).send({ error: 'input not found' });
    }
    if (row.mime) reply.type(row.mime);
    return reply.send(fs.createReadStream(filePath));
  });
}
