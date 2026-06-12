import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCodeAdapter } from './claude-code.js';
import type { EngineAdapter, SpawnRequest, SpawnSpec } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MOCK_CLI_PATH = path.join(__dirname, 'mock-cli.cjs');

/**
 * Mock engine: spawns mock-cli.cjs which replays a scripted claude-style
 * stream from the profile's MOCK_SCRIPT env value. Parsing/classification
 * are delegated to the claude-code adapter since the wire format matches.
 */
export const mockAdapter: EngineAdapter = {
  id: 'mock',

  buildSpawn(req: SpawnRequest): SpawnSpec {
    return {
      cmd: process.execPath,
      args: [MOCK_CLI_PATH, req.prompt],
      env: { ...process.env, ...req.profile.resolvedEnv },
    };
  },

  parseLine: (line) => claudeCodeAdapter.parseLine(line),
  classify: (exit, stderr, result) => claudeCodeAdapter.classify(exit, stderr, result),
};
