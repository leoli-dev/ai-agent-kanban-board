import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { DATA_DIR, DB_PATH, HOST, PORT, SECRETS_PATH, WEB_DIST, WORKSPACES_DIR } from './config.js';
import { openDb } from './db/index.js';
import { SettingsStore } from './db/settings-store.js';
import { WsHub } from './ws/hub.js';
import { SecretStore } from './providers/secrets.js';
import { ProviderRegistry } from './providers/registry.js';
import { RunStore } from './runner/run-store.js';
import { AgentRunner } from './runner/agent-runner.js';
import type { AppContext } from './context.js';
import { registerRoutes } from './routes/index.js';

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

  const { db, sqlite } = openDb(DB_PATH);
  const hub = new WsHub();
  const settings = new SettingsStore(db);
  const secrets = new SecretStore(SECRETS_PATH);
  const registry = new ProviderRegistry(db, secrets);
  const runStore = new RunStore(db, hub);
  const runner = new AgentRunner({ registry, runStore, settings, hub });
  runner.recoverOrphans();

  const ctx: AppContext = {
    db,
    sqlite,
    hub,
    settings,
    secrets,
    registry,
    runStore,
    runner,
    dataDir: DATA_DIR,
    workspacesDir: WORKSPACES_DIR,
  };

  const app = Fastify({ logger: { level: 'info' } });
  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart, {
    limits: { fileSize: 200 * 1024 * 1024, files: 20 },
  });

  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket) => {
      hub.register(socket);
    });
  });

  await registerRoutes(app, ctx);

  if (fs.existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
    app.setNotFoundHandler((req, reply) => {
      // SPA fallback for client-side routes; API misses stay 404.
      if (req.raw.url?.startsWith('/api') || req.raw.url?.startsWith('/ws')) {
        reply.code(404).send({ error: 'not found' });
      } else {
        reply.sendFile('index.html');
      }
    });
  }

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`agent-kanban-board listening on http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
