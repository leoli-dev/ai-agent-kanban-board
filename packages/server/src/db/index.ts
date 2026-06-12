import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { migrate } from './migrate.js';

export type Db = BetterSQLite3Database<typeof schema>;

export function openDb(dbPath: string): { db: Db; sqlite: Database.Database } {
  const sqlite = new Database(dbPath);
  migrate(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export { schema };
