import type { EngineId } from '@akb/shared';
import type { EngineAdapter } from './types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { mockAdapter } from './mock.js';

const adapters = new Map<EngineId, EngineAdapter>([
  ['claude-code', claudeCodeAdapter],
  ['codex', codexAdapter],
  ['mock', mockAdapter],
]);

export function getAdapter(engine: EngineId): EngineAdapter {
  const adapter = adapters.get(engine);
  if (!adapter) throw new Error(`No adapter for engine "${engine}"`);
  return adapter;
}

export function registerAdapter(adapter: EngineAdapter): void {
  adapters.set(adapter.id, adapter);
}
