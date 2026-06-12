import { desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AgentRole, AgentRun, FailureClass, RunStatus } from '@akb/shared';
import { schema, type Db } from '../db/index.js';
import { toAgentRun } from '../db/mappers.js';
import type { WsHub } from '../ws/hub.js';

export interface CreateRunInput {
  id?: string;
  taskId?: string | null;
  projectId?: string | null;
  role: AgentRole;
  providerProfileId: string;
  logPath: string;
  pid?: number | null;
}

export class RunStore {
  constructor(
    private db: Db,
    private hub: WsHub,
  ) {}

  create(input: CreateRunInput): AgentRun {
    const id = input.id ?? nanoid(12);
    const now = Date.now();
    this.db
      .insert(schema.agentRuns)
      .values({
        id,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        role: input.role,
        providerProfileId: input.providerProfileId,
        status: 'running',
        startedAt: now,
        lastEventAt: now,
        logPath: input.logPath,
        pid: input.pid ?? null,
      })
      .run();
    const run = this.get(id)!;
    this.publish('run.started', run);
    return run;
  }

  get(id: string): AgentRun | null {
    const row = this.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)).get();
    return row ? toAgentRun(row) : null;
  }

  update(
    id: string,
    patch: Partial<{
      status: RunStatus;
      failureClass: FailureClass | null;
      engineSessionId: string | null;
      endedAt: number | null;
      lastEventAt: number;
      pid: number | null;
      numTurns: number | null;
      inputTokens: number | null;
      outputTokens: number | null;
      costUsd: number | null;
      exitCode: number | null;
      resultText: string | null;
    }>,
  ): AgentRun | null {
    this.db.update(schema.agentRuns).set(patch).where(eq(schema.agentRuns.id, id)).run();
    const run = this.get(id);
    if (run) this.publish('run.updated', run);
    return run;
  }

  /** Heartbeat: bump last_event_at without a WS broadcast. */
  beat(id: string, ts: number): void {
    this.db
      .update(schema.agentRuns)
      .set({ lastEventAt: ts })
      .where(eq(schema.agentRuns.id, id))
      .run();
  }

  listByTask(taskId: string): AgentRun[] {
    return this.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.taskId, taskId))
      .orderBy(desc(schema.agentRuns.startedAt))
      .all()
      .map(toAgentRun);
  }

  listByProject(projectId: string): AgentRun[] {
    return this.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.projectId, projectId))
      .orderBy(desc(schema.agentRuns.startedAt))
      .all()
      .map(toAgentRun);
  }

  listByProfile(profileId: string, limit = 10): AgentRun[] {
    return this.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.providerProfileId, profileId))
      .orderBy(desc(schema.agentRuns.startedAt))
      .limit(limit)
      .all()
      .map(toAgentRun);
  }

  listRecent(limit = 100): AgentRun[] {
    return this.db
      .select()
      .from(schema.agentRuns)
      .orderBy(desc(schema.agentRuns.startedAt))
      .limit(limit)
      .all()
      .map(toAgentRun);
  }

  listRunning(): AgentRun[] {
    return this.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.status, 'running'))
      .all()
      .map(toAgentRun);
  }

  private publish(type: 'run.started' | 'run.updated', run: AgentRun): void {
    this.hub.publish(`run:${run.id}`, { type, run });
    if (run.projectId) this.hub.publish(`board:${run.projectId}`, { type, run });
  }
}
