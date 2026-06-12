import { integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  prompt: text('prompt').notNull(),
  status: text('status').notNull().default('draft'),
  workspacePath: text('workspace_path').notNull(),
  targetRepoPath: text('target_repo_path').notNull(),
  gitBranch: text('git_branch'),
  createdAt: integer('created_at').notNull(),
  completedAt: integer('completed_at'),
});

export const projectInputs = sqliteTable('project_inputs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  kind: text('kind').notNull(),
  pathOrUrl: text('path_or_url').notNull(),
  originalName: text('original_name'),
  mime: text('mime'),
  size: integer('size'),
});

export const planDocuments = sqliteTable('plan_documents', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  version: integer('version').notNull(),
  mdPath: text('md_path').notNull(),
  jsonPath: text('json_path').notNull(),
  status: text('status').notNull().default('draft'),
  approvedAt: integer('approved_at'),
});

export const plannerSessions = sqliteTable('planner_sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  engineSessionId: text('engine_session_id'),
  providerProfileId: text('provider_profile_id'),
  status: text('status').notNull().default('active'),
  qaRound: integer('qa_round').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const plannerMessages = sqliteTable('planner_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  role: text('role').notNull(),
  contentJson: text('content_json').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  planStepId: text('plan_step_id'),
  title: text('title').notNull(),
  description: text('description').notNull(),
  acceptanceCriteriaJson: text('acceptance_criteria_json').notNull().default('[]'),
  status: text('status').notNull().default('backlog'),
  orderIndex: integer('order_index').notNull().default(0),
  retryCount: integer('retry_count').notNull().default(0),
  bounceCount: integer('bounce_count').notNull().default(0),
  blockedReason: text('blocked_reason'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    taskId: text('task_id').notNull(),
    dependsOnTaskId: text('depends_on_task_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnTaskId] })],
);

export const providerProfiles = sqliteTable('provider_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  engine: text('engine').notNull(),
  envJson: text('env_json').notNull().default('{}'),
  modelLabel: text('model_label'),
  enabled: integer('enabled').notNull().default(1),
  cooldownUntil: integer('cooldown_until'),
  disabledReason: text('disabled_reason'),
  lastOkAt: integer('last_ok_at'),
  notes: text('notes'),
});

export const roleAssignments = sqliteTable(
  'role_assignments',
  {
    id: text('id').primaryKey(),
    role: text('role').notNull(),
    providerProfileId: text('provider_profile_id').notNull(),
    priority: integer('priority').notNull(),
  },
  (t) => [uniqueIndex('role_priority_unique').on(t.role, t.priority)],
);

export const agentRuns = sqliteTable('agent_runs', {
  id: text('id').primaryKey(),
  taskId: text('task_id'),
  projectId: text('project_id'),
  role: text('role').notNull(),
  providerProfileId: text('provider_profile_id').notNull(),
  engineSessionId: text('engine_session_id'),
  status: text('status').notNull().default('running'),
  failureClass: text('failure_class'),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  lastEventAt: integer('last_event_at').notNull(),
  logPath: text('log_path').notNull(),
  pid: integer('pid'),
  numTurns: integer('num_turns'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costUsd: real('cost_usd'),
  exitCode: integer('exit_code'),
  resultText: text('result_text'),
});

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  projectId: text('project_id'),
  read: integer('read').notNull().default(0),
  channelsSentJson: text('channels_sent_json').notNull().default('[]'),
  createdAt: integer('created_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
});
