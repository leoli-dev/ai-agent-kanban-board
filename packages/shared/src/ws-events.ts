import type { AgentRun, AppNotification, Project, Task } from './types.js';

/** Client -> server */
export type WsClientMessage =
  | { type: 'subscribe'; topics: string[] }
  | { type: 'unsubscribe'; topics: string[] }
  | { type: 'ping' };

/** Server -> client. Topics: 'global', `board:<projectId>`, `run:<runId>` */
export type WsServerMessage =
  | { type: 'pong' }
  | { type: 'task.updated'; task: Task }
  | { type: 'task.deleted'; taskId: string; projectId: string }
  | { type: 'tasks.created'; projectId: string; tasks: Task[] }
  | { type: 'task.decompose_failed'; taskId: string; projectId: string; error: string }
  | { type: 'project.updated'; project: Project }
  | { type: 'run.started'; run: AgentRun }
  | { type: 'run.updated'; run: AgentRun }
  | {
      type: 'run.event';
      runId: string;
      event: { kind: string; text?: string; tool?: string; detail?: string; raw?: unknown; ts: number };
    }
  | { type: 'question.pending'; projectId: string; sessionId: string }
  | { type: 'plan.ready'; projectId: string }
  | { type: 'notification.new'; notification: AppNotification };
