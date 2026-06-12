import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, '../../..');
export const DATA_DIR = process.env.AKB_DATA_DIR ?? path.join(REPO_ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'app.db');
export const SECRETS_PATH = path.join(DATA_DIR, 'secrets.json');
export const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
export const WEB_DIST = path.join(REPO_ROOT, 'packages/web/dist');

export const PORT = Number(process.env.AKB_PORT ?? 5713);
export const HOST = process.env.AKB_HOST ?? '0.0.0.0';

/** How often the orchestrator safety tick runs. */
export const SAFETY_TICK_MS = 15_000;
/** Cooldown applied to a provider profile after a quota failure. */
export const QUOTA_COOLDOWN_MS = 15 * 60_000;
/** Max WS run-event messages per second per run (UI throttle). */
export const RUN_EVENT_THROTTLE_PER_SEC = 10;
