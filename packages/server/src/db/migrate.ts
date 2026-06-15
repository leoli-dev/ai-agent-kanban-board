import type Database from 'better-sqlite3';

/**
 * Idempotent schema bootstrap. We intentionally avoid drizzle-kit: a fresh
 * single-user app with CREATE TABLE IF NOT EXISTS keeps the toolchain minimal.
 * Column definitions must stay in sync with schema.ts.
 */
export function migrate(sqlite: Database.Database): void {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  workspace_path TEXT NOT NULL,
  target_repo_path TEXT NOT NULL,
  git_branch TEXT,
  fresh_repo INTEGER NOT NULL DEFAULT 0,
  live_url TEXT,
  run_pid INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS project_inputs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path_or_url TEXT NOT NULL,
  original_name TEXT,
  mime TEXT,
  size INTEGER
);

CREATE TABLE IF NOT EXISTS plan_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  md_path TEXT NOT NULL,
  json_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  approved_at INTEGER
);

CREATE TABLE IF NOT EXISTS planner_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  engine_session_id TEXT,
  provider_profile_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  qa_round INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS planner_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  plan_step_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'backlog',
  order_index INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  bounce_count INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  engine TEXT NOT NULL,
  env_json TEXT NOT NULL DEFAULT '{}',
  model_label TEXT,
  tier TEXT NOT NULL DEFAULT 'low',
  enabled INTEGER NOT NULL DEFAULT 1,
  cooldown_until INTEGER,
  disabled_reason TEXT,
  last_ok_at INTEGER,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS role_assignments (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  provider_profile_id TEXT NOT NULL,
  priority INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS role_priority_unique ON role_assignments (role, priority);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  project_id TEXT,
  role TEXT NOT NULL,
  provider_profile_id TEXT NOT NULL,
  engine_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  failure_class TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_event_at INTEGER NOT NULL,
  log_path TEXT NOT NULL,
  pid INTEGER,
  num_turns INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  exit_code INTEGER,
  result_text TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  project_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  channels_sent_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
`);

  // Additive column migrations for databases created before the column existed.
  addColumnIfMissing(sqlite, 'provider_profiles', 'tier', "TEXT NOT NULL DEFAULT 'low'");
  addColumnIfMissing(sqlite, 'projects', 'fresh_repo', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(sqlite, 'projects', 'live_url', 'TEXT');
  addColumnIfMissing(sqlite, 'projects', 'run_pid', 'INTEGER');
  addColumnIfMissing(sqlite, 'projects', 'base_commit', 'TEXT');
}

/** SQLite has no `ADD COLUMN IF NOT EXISTS`; check the table shape first. */
function addColumnIfMissing(
  sqlite: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
