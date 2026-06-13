export const PROJECT_STATUSES = [
  'draft',
  'planning',
  'awaiting_answers',
  'awaiting_approval',
  'running',
  'paused',
  'done',
  'failed',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TASK_STATUSES = [
  'backlog',
  'wip',
  'to_review',
  'to_test',
  'done',
  'failed',
  'blocked',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const KANBAN_COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'wip', label: 'WIP' },
  { status: 'to_review', label: 'To Review' },
  { status: 'to_test', label: 'To Test' },
  { status: 'done', label: 'Done' },
];

export const AGENT_ROLES = [
  'planner',
  'task-creator',
  'coder',
  'reviewer',
  'tester',
  'debugger',
  'orchestrator',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const ENGINES = ['claude-code', 'codex', 'mock'] as const;
export type EngineId = (typeof ENGINES)[number];

export const RUN_STATUSES = ['running', 'succeeded', 'failed', 'killed', 'stuck'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const FAILURE_CLASSES = ['QUOTA', 'AUTH', 'CRASH', 'TASK_FAIL', 'OK'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const INPUT_KINDS = ['file', 'image', 'video', 'pdf', 'link', 'markdown'] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export const NOTIFICATION_TYPES = [
  'plan_ready',
  'question_pending',
  'task_failed',
  'project_done',
  'provider_down',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface Project {
  id: string;
  name: string;
  prompt: string;
  status: ProjectStatus;
  workspacePath: string;
  targetRepoPath: string;
  gitBranch: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface ProjectInput {
  id: string;
  projectId: string;
  kind: InputKind;
  pathOrUrl: string;
  originalName: string | null;
  mime: string | null;
  size: number | null;
}

export interface PlanDocument {
  id: string;
  projectId: string;
  version: number;
  mdPath: string;
  jsonPath: string;
  status: 'draft' | 'approved' | 'rejected';
  approvedAt: number | null;
}

export interface Task {
  id: string;
  projectId: string;
  planStepId: string | null;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  orderIndex: number;
  retryCount: number;
  bounceCount: number;
  blockedReason: string | null;
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
}

/** A model's intelligence/capability tier, used to escalate work that a weaker
 * model can't get accepted. Ordered low < medium < high. */
export const MODEL_TIERS = ['low', 'medium', 'high'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const TIER_RANK: Record<ModelTier, number> = { low: 0, medium: 1, high: 2 };

export interface ProviderProfile {
  id: string;
  name: string;
  engine: EngineId;
  env: Record<string, string>;
  modelLabel: string | null;
  tier: ModelTier;
  enabled: boolean;
  cooldownUntil: number | null;
  disabledReason: string | null;
  lastOkAt: number | null;
  notes: string | null;
}

export interface RoleAssignment {
  id: string;
  role: AgentRole;
  providerProfileId: string;
  priority: number;
}

export interface AgentRun {
  id: string;
  taskId: string | null;
  projectId: string | null;
  role: AgentRole;
  providerProfileId: string;
  engineSessionId: string | null;
  status: RunStatus;
  failureClass: FailureClass | null;
  startedAt: number;
  endedAt: number | null;
  lastEventAt: number;
  logPath: string;
  pid: number | null;
  numTurns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  exitCode: number | null;
  resultText: string | null;
}

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  projectId: string | null;
  read: boolean;
  channelsSent: string[];
  createdAt: number;
}

export interface PlannerMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'planner' | 'question' | 'answer';
  content: unknown;
  createdAt: number;
}

export interface Settings {
  stuckThresholdMin: number;
  wallClockLimitMin: number;
  maxRetries: number;
  maxBounces: number;
  concurrency: number;
  maxQaRounds: number;
  autoAdvanceReview: boolean;
  autoAdvanceTest: boolean;
  notifyMacos: boolean;
  notifyEmail: boolean;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
    to: string;
  } | null;
}

export const DEFAULT_SETTINGS: Settings = {
  stuckThresholdMin: 10,
  wallClockLimitMin: 60,
  maxRetries: 2,
  maxBounces: 2,
  concurrency: 2,
  maxQaRounds: 5,
  autoAdvanceReview: true,
  autoAdvanceTest: true,
  notifyMacos: true,
  notifyEmail: false,
  smtp: null,
};
