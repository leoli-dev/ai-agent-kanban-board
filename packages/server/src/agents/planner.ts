import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  AnswersFileSchema,
  PLAN_JSON_CONTRACT,
  PlanDocSchema,
  QA_JSON_CONTRACT,
  QuestionsFileSchema,
  type Answer,
  type Project,
} from '@akb/shared';
import { schema, type Db } from '../db/index.js';
import { toProject } from '../db/mappers.js';
import type { SettingsStore } from '../db/settings-store.js';
import type { AgentRunner, RunOutcome } from '../runner/agent-runner.js';
import type { WsHub } from '../ws/hub.js';
import { workspacePaths, type WorkspacePaths } from '../workspace/workspace.js';
import { createTasksFromPlan } from './task-creator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLANNER_CONTRACT = fs.readFileSync(path.join(__dirname, 'prompts/planner.md'), 'utf8');

interface PlannerDeps {
  db: Db;
  hub: WsHub;
  runner: AgentRunner;
  settings: SettingsStore;
  workspacesDir: string;
}

export class PlannerService {
  constructor(private deps: PlannerDeps) {}

  /** Kick off (or restart) planning. Callers may ignore the returned promise. */
  start(projectId: string): Promise<void> {
    const project = this.getProject(projectId);
    const sessionId = nanoid(10);
    this.deps.db
      .insert(schema.plannerSessions)
      .values({ id: sessionId, projectId, status: 'active', createdAt: Date.now() })
      .run();
    this.setProjectStatus(projectId, 'planning');
    this.addMessage(sessionId, 'user', { text: project.prompt });

    const prompt = this.buildInitialPrompt(project, 1);
    return this.execute(sessionId, projectId, prompt, undefined);
  }

  /** User answered the pending questions; resume the session. */
  answer(projectId: string, answers: Answer[]): Promise<void> {
    const session = this.latestSession(projectId);
    if (!session) throw new Error('no planner session');
    const parsed = AnswersFileSchema.parse({ answers });
    const ws = workspacePaths(this.deps.workspacesDir, projectId);
    const round = session.qaRound;
    const answersPath = path.join(ws.qa, `answers-${round}.json`);
    fs.writeFileSync(answersPath, JSON.stringify(parsed, null, 2));
    this.addMessage(session.id, 'answer', parsed);
    this.setProjectStatus(projectId, 'planning');

    const nextQuestionsPath = path.join(ws.qa, `questions-${round + 1}.json`);
    const maxRounds = this.deps.settings.get().maxQaRounds;
    const noMore = round >= maxRounds;
    const prompt =
      `The user answered your questions. Answers JSON file: ${answersPath}\n` +
      answersBlock(parsed.answers) +
      (noMore
        ? `\nNo further questions are allowed. Write the plan files now and end with PLAN_READY.`
        : `\nIf anything essential is still unclear you may ask once more by writing ${nextQuestionsPath} and ending with QUESTIONS_PENDING. Otherwise write the plan files and end with PLAN_READY.`);
    return this.execute(session.id, projectId, prompt, session.engineSessionId ?? undefined);
  }

  /** Plan rejected with a comment; send it back to the planner. */
  reject(projectId: string, comment: string): Promise<void> {
    const session = this.latestSession(projectId);
    if (!session) throw new Error('no planner session');
    this.deps.db
      .update(schema.planDocuments)
      .set({ status: 'rejected' })
      .where(eq(schema.planDocuments.projectId, projectId))
      .run();
    this.addMessage(session.id, 'answer', { text: `Plan rejected: ${comment}` });
    this.setProjectStatus(projectId, 'planning');
    const prompt = `The user reviewed your plan and requests changes:\n\n${comment}\n\nRevise BOTH plan files (overwrite them) and end with PLAN_READY.`;
    return this.execute(session.id, projectId, prompt, session.engineSessionId ?? undefined);
  }

  /** Approve the latest plan: create kanban tasks and start the project. */
  approve(projectId: string): { taskCount: number } {
    const planRow = this.deps.db
      .select()
      .from(schema.planDocuments)
      .where(eq(schema.planDocuments.projectId, projectId))
      .orderBy(desc(schema.planDocuments.version))
      .get();
    if (!planRow) throw new Error('no plan to approve');
    const planJson = JSON.parse(fs.readFileSync(planRow.jsonPath, 'utf8')) as unknown;
    const tasks = createTasksFromPlan(this.deps.db, this.deps.hub, projectId, planJson);
    this.deps.db
      .update(schema.planDocuments)
      .set({ status: 'approved', approvedAt: Date.now() })
      .where(eq(schema.planDocuments.id, planRow.id))
      .run();
    this.setProjectStatus(projectId, 'running');
    return { taskCount: tasks.length };
  }

  private async execute(
    sessionId: string,
    projectId: string,
    prompt: string,
    resumeEngineSessionId: string | undefined,
  ): Promise<void> {
    const project = this.getProject(projectId);
    const ws = workspacePaths(this.deps.workspacesDir, projectId);
    const session = this.deps.db
      .select()
      .from(schema.plannerSessions)
      .where(eq(schema.plannerSessions.id, sessionId))
      .get()!;

    try {
      let outcome: RunOutcome;
      const base = {
        role: 'planner' as const,
        cwd: project.targetRepoPath,
        logDir: ws.logs,
        projectId,
        addDirs: [ws.root],
        systemAppend: PLANNER_CONTRACT,
      };

      if (resumeEngineSessionId && session.providerProfileId) {
        // Resume only on the same provider; on failure fall through to fresh.
        outcome = await this.deps.runner.run({
          ...base,
          prompt,
          profileId: session.providerProfileId,
          resumeSessionId: resumeEngineSessionId,
        });
        if (!outcome.ok && outcome.failureClass !== 'TASK_FAIL') {
          const fresh = this.buildInitialPrompt(project, session.qaRound + 1, this.historyBlock(sessionId));
          outcome = await this.deps.runner.run({ ...base, prompt: fresh });
        }
      } else {
        outcome = await this.deps.runner.run({ ...base, prompt });
      }

      if (!outcome.ok || !outcome.finalRun) {
        this.failSession(sessionId, projectId, outcome.finalRun?.resultText ?? 'planner run failed');
        return;
      }

      // Pin session to the provider that actually answered, for future resumes.
      this.deps.db
        .update(schema.plannerSessions)
        .set({
          providerProfileId: outcome.finalRun.providerProfileId,
          engineSessionId: outcome.finalRun.engineSessionId,
        })
        .where(eq(schema.plannerSessions.id, sessionId))
        .run();

      const resultText = outcome.finalRun.resultText ?? '';
      this.addMessage(sessionId, 'planner', { text: resultText });

      if (/QUESTIONS_PENDING\s*$/.test(resultText.trim())) {
        this.handleQuestions(sessionId, projectId, ws);
      } else if (/PLAN_READY\s*$/.test(resultText.trim())) {
        await this.handlePlanReady(sessionId, projectId, ws, outcome);
      } else {
        // No sentinel: nudge once to follow the protocol.
        const run = outcome.finalRun;
        const nudge =
          'You did not end with QUESTIONS_PENDING or PLAN_READY. Follow the protocol now: either write the questions file and end with QUESTIONS_PENDING, or write both plan files and end with PLAN_READY.';
        const retry = await this.deps.runner.run({
          role: 'planner',
          prompt: nudge,
          cwd: project.targetRepoPath,
          logDir: ws.logs,
          projectId,
          addDirs: [ws.root],
          systemAppend: PLANNER_CONTRACT,
          profileId: run.providerProfileId,
          resumeSessionId: run.engineSessionId ?? undefined,
        });
        const retryText = retry.finalRun?.resultText ?? '';
        this.addMessage(sessionId, 'planner', { text: retryText });
        if (/QUESTIONS_PENDING\s*$/.test(retryText.trim())) {
          this.handleQuestions(sessionId, projectId, ws);
        } else if (/PLAN_READY\s*$/.test(retryText.trim())) {
          await this.handlePlanReady(sessionId, projectId, ws, retry);
        } else {
          this.failSession(sessionId, projectId, 'planner did not follow the output protocol');
        }
      }
    } catch (err) {
      this.failSession(sessionId, projectId, String(err));
    }
  }

  private handleQuestions(sessionId: string, projectId: string, ws: WorkspacePaths): void {
    const session = this.deps.db
      .select()
      .from(schema.plannerSessions)
      .where(eq(schema.plannerSessions.id, sessionId))
      .get()!;
    const round = session.qaRound + 1;
    const file = path.join(ws.qa, `questions-${round}.json`);
    let questions: unknown;
    try {
      questions = QuestionsFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      this.failSession(sessionId, projectId, `planner wrote invalid questions file: ${String(err)}`);
      return;
    }
    this.deps.db
      .update(schema.plannerSessions)
      .set({ qaRound: round })
      .where(eq(schema.plannerSessions.id, sessionId))
      .run();
    this.addMessage(sessionId, 'question', questions);
    this.setProjectStatus(projectId, 'awaiting_answers');
    this.deps.hub.publish('global', { type: 'question.pending', projectId, sessionId });
    this.deps.hub.publish(`board:${projectId}`, { type: 'question.pending', projectId, sessionId });
  }

  private async handlePlanReady(
    sessionId: string,
    projectId: string,
    ws: WorkspacePaths,
    outcome: RunOutcome,
  ): Promise<void> {
    const jsonPath = path.join(ws.plan, 'plan.json');
    const mdPath = path.join(ws.plan, 'plan.md');
    const project = this.getProject(projectId);

    const validate = (): string | null => {
      try {
        PlanDocSchema.parse(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
        if (!fs.existsSync(mdPath)) return 'plan.md is missing';
        return null;
      } catch (err) {
        return String(err);
      }
    };

    let problem = validate();
    if (problem) {
      // One repair round on the same session.
      const repair = await this.deps.runner.run({
        role: 'planner',
        prompt: `Your plan files failed validation:\n${problem}\n\nFix ${jsonPath} (schema below) and ${mdPath}, then end with PLAN_READY.\n\nSchema:\n${PLAN_JSON_CONTRACT}`,
        cwd: project.targetRepoPath,
        logDir: ws.logs,
        projectId,
        addDirs: [ws.root],
        systemAppend: PLANNER_CONTRACT,
        profileId: outcome.finalRun!.providerProfileId,
        resumeSessionId: outcome.finalRun!.engineSessionId ?? undefined,
      });
      this.addMessage(sessionId, 'planner', { text: repair.finalRun?.resultText ?? '' });
      problem = validate();
      if (problem) {
        this.failSession(sessionId, projectId, `plan validation failed after repair: ${problem}`);
        return;
      }
    }

    const version =
      (this.deps.db
        .select()
        .from(schema.planDocuments)
        .where(eq(schema.planDocuments.projectId, projectId))
        .orderBy(desc(schema.planDocuments.version))
        .get()?.version ?? 0) + 1;
    this.deps.db
      .insert(schema.planDocuments)
      .values({ id: nanoid(10), projectId, version, mdPath, jsonPath, status: 'draft' })
      .run();
    this.deps.db
      .update(schema.plannerSessions)
      .set({ status: 'done' })
      .where(eq(schema.plannerSessions.id, sessionId))
      .run();
    this.setProjectStatus(projectId, 'awaiting_approval');
    this.deps.hub.publish('global', { type: 'plan.ready', projectId });
    this.deps.hub.publish(`board:${projectId}`, { type: 'plan.ready', projectId });
  }

  private buildInitialPrompt(project: Project, questionRound: number, extraContext = ''): string {
    const ws = workspacePaths(this.deps.workspacesDir, project.id);
    const inputs = this.deps.db
      .select()
      .from(schema.projectInputs)
      .where(eq(schema.projectInputs.projectId, project.id))
      .all();
    const inputLines = inputs.length
      ? inputs
          .map((i) =>
            i.kind === 'link'
              ? `- link: ${i.pathOrUrl} (fetch it if relevant)`
              : `- ${i.kind}: ${i.pathOrUrl}${i.originalName ? ` (original name: ${i.originalName})` : ''}${i.kind === 'video' ? ' — you cannot watch videos; if its content matters, ask the user to describe it' : ''}`,
          )
          .join('\n')
      : '(none)';

    return `# Project: ${project.name}

## User's idea
${project.prompt}

## Provided resources
${inputLines}

## Environment
- Project workspace (write your output files here): ${ws.root}
- Target repository (read-only for you): ${project.targetRepoPath}

## Output files
- Questions (only if needed): ${path.join(ws.qa, `questions-${questionRound}.json`)} with schema:
${QA_JSON_CONTRACT}
- Plan markdown: ${path.join(ws.plan, 'plan.md')}
- Plan JSON: ${path.join(ws.plan, 'plan.json')} with schema:
${PLAN_JSON_CONTRACT}
${extraContext ? `\n## Prior session context\n${extraContext}\n` : ''}
Begin. Explore the target repository first if useful.`;
  }

  /** Compact Q&A transcript used when a session must restart on a new provider. */
  private historyBlock(sessionId: string): string {
    const messages = this.deps.db
      .select()
      .from(schema.plannerMessages)
      .where(eq(schema.plannerMessages.sessionId, sessionId))
      .all();
    return messages
      .map((m) => `[${m.role}] ${m.contentJson.slice(0, 2000)}`)
      .join('\n');
  }

  private failSession(sessionId: string, projectId: string, reason: string): void {
    this.deps.db
      .update(schema.plannerSessions)
      .set({ status: 'failed' })
      .where(eq(schema.plannerSessions.id, sessionId))
      .run();
    this.addMessage(sessionId, 'planner', { text: `Planning failed: ${reason}` });
    this.setProjectStatus(projectId, 'draft');
  }

  latestSession(projectId: string) {
    return this.deps.db
      .select()
      .from(schema.plannerSessions)
      .where(eq(schema.plannerSessions.projectId, projectId))
      .orderBy(desc(schema.plannerSessions.createdAt))
      .get();
  }

  private addMessage(sessionId: string, role: string, content: unknown): void {
    this.deps.db
      .insert(schema.plannerMessages)
      .values({
        id: nanoid(10),
        sessionId,
        role,
        contentJson: JSON.stringify(content),
        createdAt: Date.now(),
      })
      .run();
  }

  private getProject(projectId: string): Project {
    const row = this.deps.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .get();
    if (!row) throw new Error(`project ${projectId} not found`);
    return toProject(row);
  }

  private setProjectStatus(projectId: string, status: Project['status']): void {
    this.deps.db
      .update(schema.projects)
      .set({ status, ...(status === 'done' ? { completedAt: Date.now() } : {}) })
      .where(eq(schema.projects.id, projectId))
      .run();
    const project = this.getProject(projectId);
    this.deps.hub.publish('global', { type: 'project.updated', project });
    this.deps.hub.publish(`board:${projectId}`, { type: 'project.updated', project });
  }
}

function answersBlock(answers: Answer[]): string {
  return answers.map((a) => `- ${a.questionId}: ${a.answer}`).join('\n');
}
