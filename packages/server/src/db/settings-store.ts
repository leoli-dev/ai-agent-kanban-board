import { eq } from 'drizzle-orm';
import { DEFAULT_SETTINGS, type Settings } from '@akb/shared';
import { schema, type Db } from './index.js';

const KEY = 'app';

export class SettingsStore {
  constructor(private db: Db) {}

  get(): Settings {
    const row = this.db.select().from(schema.settings).where(eq(schema.settings.key, KEY)).get();
    if (!row) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.valueJson) as Partial<Settings>) };
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.get(), ...patch };
    this.db
      .insert(schema.settings)
      .values({ key: KEY, valueJson: JSON.stringify(next) })
      .onConflictDoUpdate({ target: schema.settings.key, set: { valueJson: JSON.stringify(next) } })
      .run();
    return next;
  }
}
