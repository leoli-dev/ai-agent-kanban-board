import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRole, ModelTier } from '@akb/shared';
import { openDb } from '../src/db/index.js';
import { SettingsStore } from '../src/db/settings-store.js';
import { WsHub } from '../src/ws/hub.js';
import { SecretStore } from '../src/providers/secrets.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { RunStore } from '../src/runner/run-store.js';
import { AgentRunner } from '../src/runner/agent-runner.js';

export interface TestCtx {
  db: ReturnType<typeof openDb>['db'];
  hub: WsHub;
  settings: SettingsStore;
  registry: ProviderRegistry;
  runStore: RunStore;
  runner: AgentRunner;
  tmpDir: string;
}

export function makeTestCtx(): TestCtx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-test-'));
  const { db } = openDb(':memory:');
  const hub = new WsHub();
  const settings = new SettingsStore(db);
  const secrets = new SecretStore(path.join(tmpDir, 'secrets.json'));
  const registry = new ProviderRegistry(db, secrets);
  const runStore = new RunStore(db, hub);
  const runner = new AgentRunner({ registry, runStore, settings, hub }, { crashRetryDelayMs: 10 });
  return { db, hub, settings, registry, runStore, runner, tmpDir };
}

export interface MockScript {
  events: { delayMs?: number; line: unknown }[];
  exitCode?: number;
  stallMs?: number;
  stderr?: string;
  writeFiles?: { path: string; content: string }[];
}

let profileCounter = 0;

export function addMockProfile(
  ctx: TestCtx,
  role: AgentRole | null,
  script: MockScript,
  tier: ModelTier = 'low',
) {
  const name = `mock-${++profileCounter}`;
  const profile = ctx.registry.create({
    name,
    engine: 'mock',
    env: { MOCK_SCRIPT: JSON.stringify(script) },
    tier,
  });
  if (role) {
    const existing = ctx.registry.assignments(role).map((a) => a.providerProfileId);
    ctx.registry.setRoleOrder(role, [...existing, profile.id]);
  }
  return profile;
}

const init = (sid = `sess-${Math.random().toString(36).slice(2, 8)}`) => ({
  type: 'system',
  subtype: 'init',
  session_id: sid,
});

export const scripts = {
  success(text = 'done', extra: Partial<MockScript> = {}): MockScript {
    return {
      events: [
        { line: init() },
        { delayMs: 20, line: { type: 'assistant', message: { content: [{ type: 'text', text: 'working...' }] } } },
        {
          delayMs: 20,
          line: {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: text,
            usage: { input_tokens: 100, output_tokens: 50 },
            total_cost_usd: 0.01,
            num_turns: 3,
          },
        },
      ],
      exitCode: 0,
      ...extra,
    };
  },
  quota(): MockScript {
    return {
      events: [
        { line: init() },
        {
          delayMs: 20,
          line: {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            result: 'API Error: 429 rate limit exceeded — credit balance too low',
            num_turns: 1,
          },
        },
      ],
      exitCode: 1,
    };
  },
  auth(): MockScript {
    return {
      events: [
        { line: init() },
        {
          delayMs: 20,
          line: {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            result: 'API Error: 401 invalid api key provided',
            num_turns: 1,
          },
        },
      ],
      exitCode: 1,
    };
  },
  crash(): MockScript {
    return { events: [{ line: init() }], exitCode: 1, stderr: 'fatal: engine segfault' };
  },
  taskFail(): MockScript {
    return {
      events: [
        { line: init() },
        {
          delayMs: 20,
          line: {
            type: 'result',
            subtype: 'error_max_turns',
            is_error: true,
            result: 'Reached maximum number of turns without finishing',
            num_turns: 50,
          },
        },
      ],
      exitCode: 0,
    };
  },
  stall(stallMs = 60_000): MockScript {
    return { events: [{ line: init() }], stallMs, exitCode: 0 };
  },
};
