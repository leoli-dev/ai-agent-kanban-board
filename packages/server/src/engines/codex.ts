import { classifyOutput } from '../providers/failure-classifier.js';
import type { EngineAdapter, NormalizedEvent, SpawnRequest, SpawnSpec } from './types.js';

/**
 * Codex CLI adapter: `codex exec --json` emits JSONL thread events. There is
 * no single result event, so we accumulate the last agent message in the
 * per-attempt parse state and synthesize a result on turn completion.
 * Handles both the current thread-event shape and the legacy {id,msg} shape.
 */

interface CodexLine {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string; command?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  message?: string;
  // legacy shape
  id?: string;
  msg?: { type?: string; message?: string; last_agent_message?: string };
}

export const codexAdapter: EngineAdapter = {
  id: 'codex',

  buildSpawn(req: SpawnRequest): SpawnSpec {
    const env = { ...process.env, ...req.profile.resolvedEnv };
    const cmd = req.profile.resolvedEnv.CODEX_BIN ?? 'codex';

    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (req.resumeSessionId) args.splice(1, 0, 'resume', req.resumeSessionId);

    const sandbox = req.profile.resolvedEnv.CODEX_SANDBOX ?? 'workspace-write';
    args.push('--sandbox', sandbox);
    if (sandbox === 'workspace-write' && req.addDirs.length) {
      args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(req.addDirs)}`);
    }
    if (req.profile.modelLabel) args.push('-m', req.profile.modelLabel);
    const effort = req.profile.resolvedEnv.CODEX_REASONING_EFFORT;
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    for (const img of req.images ?? []) args.push('-i', img);

    // codex exec has no system-prompt flag; fold the contract into the prompt.
    const prompt = req.systemAppend ? `${req.systemAppend}\n\n---\n\n${req.prompt}` : req.prompt;
    args.push(prompt);

    return { cmd, args, env };
  },

  parseLine(line: string, state: Record<string, unknown>): NormalizedEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let obj: CodexLine;
    try {
      obj = JSON.parse(trimmed) as CodexLine;
    } catch {
      return { kind: 'raw' };
    }

    // Legacy shape
    if (obj.msg?.type) {
      if (obj.msg.type === 'agent_message' && obj.msg.message) {
        state.lastText = obj.msg.message;
        return { kind: 'text', text: obj.msg.message };
      }
      if (obj.msg.type === 'task_complete') {
        return {
          kind: 'result',
          ok: state.failed !== true,
          text: (obj.msg.last_agent_message ?? state.lastText ?? '') as string,
        };
      }
      if (obj.msg.type === 'error') {
        state.failed = true;
        return { kind: 'result', ok: false, text: obj.msg.message ?? 'codex error' };
      }
      return { kind: 'raw' };
    }

    switch (obj.type) {
      case 'thread.started':
        return obj.thread_id ? { kind: 'init', sessionId: obj.thread_id } : { kind: 'raw' };
      case 'item.completed': {
        const item = obj.item;
        if (item?.type === 'agent_message' && item.text) {
          state.lastText = item.text;
          return { kind: 'text', text: item.text };
        }
        if (item?.type === 'command_execution') {
          return { kind: 'tool', tool: 'shell', detail: (item.command ?? '').slice(0, 300) };
        }
        return { kind: 'raw' };
      }
      case 'turn.completed':
        return {
          kind: 'result',
          ok: state.failed !== true,
          text: (state.lastText ?? '') as string,
          inputTokens: obj.usage?.input_tokens,
          outputTokens: obj.usage?.output_tokens,
        };
      case 'turn.failed':
      case 'error': {
        state.failed = true;
        const message = obj.error?.message ?? obj.message ?? 'codex run failed';
        return { kind: 'result', ok: false, text: message };
      }
      default:
        return { kind: 'raw' };
    }
  },

  classify(exitCode, stderrTail, lastResult) {
    return classifyOutput(exitCode, stderrTail, lastResult);
  },
};
