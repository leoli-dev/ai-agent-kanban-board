import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from '../src/engines/claude-code.js';
import type { ResolvedProfile, SpawnRequest } from '../src/engines/types.js';

const profile = { resolvedEnv: {} } as unknown as ResolvedProfile;
const base: SpawnRequest = { prompt: 'do it', profile, cwd: '/tmp', addDirs: ['/ws'] };

describe('claudeCodeAdapter.buildSpawn', () => {
  it('always passes --strict-mcp-config so agents do not inherit personal MCP servers', () => {
    const { args } = claudeCodeAdapter.buildSpawn({ ...base });
    expect(args).toContain('--strict-mcp-config');
  });

  it('adds --allowedTools followed by the given tools in order', () => {
    const tools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];
    const { args } = claudeCodeAdapter.buildSpawn({ ...base, allowedTools: tools });
    const i = args.indexOf('--allowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args.slice(i + 1, i + 1 + tools.length)).toEqual(tools);
  });

  it('omits --allowedTools when none are given (unrestricted)', () => {
    const { args } = claudeCodeAdapter.buildSpawn({ ...base });
    expect(args).not.toContain('--allowedTools');
  });
});
