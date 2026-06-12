import type Database from 'better-sqlite3';
import type { Db } from './db/index.js';
import type { SettingsStore } from './db/settings-store.js';
import type { WsHub } from './ws/hub.js';

/**
 * Dependency container threaded through routes and services so tests can
 * construct an isolated app (in-memory db, mock engines).
 * Grows as later phases add runner/orchestrator/notifier.
 */
export interface AppContext {
  db: Db;
  sqlite: Database.Database;
  hub: WsHub;
  settings: SettingsStore;
  dataDir: string;
  workspacesDir: string;
}
