import { summarizeToolInput } from '@akb/shared';
import { classifyOutput } from '../providers/failure-classifier.js';
import type { EngineAdapter, NormalizedEvent, SpawnRequest, SpawnSpec } from './types.js';

interface ClaudeStreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: {
    content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
  };
}

/** Strip host Claude config so only the profile's env applies to the run. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_API_KEY') continue;
    env[k] = v;
  }
  return env;
}

export const claudeCodeAdapter: EngineAdapter = {
  id: 'claude-code',

  buildSpawn(req: SpawnRequest): SpawnSpec {
    const args = [
      '-p',
      req.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    for (const dir of req.addDirs) args.push('--add-dir', dir);
    if (req.systemAppend) args.push('--append-system-prompt', req.systemAppend);
    if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);

    const env = { ...cleanEnv(), ...req.profile.resolvedEnv };
    const cmd = req.profile.resolvedEnv.CLAUDE_BIN ?? 'claude';
    return { cmd, args, env };
  },

  parseLine(line: string, _state: Record<string, unknown>): NormalizedEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let obj: ClaudeStreamLine;
    try {
      obj = JSON.parse(trimmed) as ClaudeStreamLine;
    } catch {
      return { kind: 'raw' };
    }

    if (obj.type === 'system' && obj.subtype === 'init' && obj.session_id) {
      return { kind: 'init', sessionId: obj.session_id };
    }
    if (obj.type === 'result') {
      return {
        kind: 'result',
        ok: obj.is_error !== true && obj.subtype === 'success',
        subtype: obj.subtype,
        text: typeof obj.result === 'string' ? obj.result : undefined,
        inputTokens: obj.usage?.input_tokens,
        outputTokens: obj.usage?.output_tokens,
        costUsd: obj.total_cost_usd,
        numTurns: obj.num_turns,
      };
    }
    if (obj.type === 'assistant') {
      const content = obj.message?.content ?? [];
      const toolUse = content.find((c) => c.type === 'tool_use');
      if (toolUse?.name) {
        return {
          kind: 'tool',
          tool: toolUse.name,
          detail: summarizeToolInput(toolUse.name, toolUse.input),
        };
      }
      const text = content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('');
      if (text) return { kind: 'text', text };
    }
    return { kind: 'raw' };
  },

  classify(exitCode, stderrTail, lastResult) {
    return classifyOutput(exitCode, stderrTail, lastResult);
  },
};
