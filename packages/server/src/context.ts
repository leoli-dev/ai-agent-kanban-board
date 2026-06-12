import type Database from 'better-sqlite3';
import type { Db } from './db/index.js';
import type { SettingsStore } from './db/settings-store.js';
import type { WsHub } from './ws/hub.js';
import type { SecretStore } from './providers/secrets.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { RunStore } from './runner/run-store.js';
import type { AgentRunner } from './runner/agent-runner.js';

/**
 * Dependency container threaded through routes and services so tests can
 * construct an isolated app (in-memory db, mock engines).
 * Grows as later phases add orchestrator/notifier.
 */
export interface AppContext {
  db: Db;
  sqlite: Database.Database;
  hub: WsHub;
  settings: SettingsStore;
  secrets: SecretStore;
  registry: ProviderRegistry;
  runStore: RunStore;
  runner: AgentRunner;
  dataDir: string;
  workspacesDir: string;
}
