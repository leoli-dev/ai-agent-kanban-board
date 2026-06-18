import type { EngineId, FailureClass, ProviderProfile } from '@akb/shared';

/** A provider profile with its env fully resolved (secrets interpolated). */
export interface ResolvedProfile extends ProviderProfile {
  resolvedEnv: Record<string, string>;
}

export type NormalizedEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: string; detail?: string }
  | {
      kind: 'result';
      ok: boolean;
      subtype?: string;
      text?: string;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      numTurns?: number;
    }
  | { kind: 'raw' };

export interface SpawnRequest {
  prompt: string;
  profile: ResolvedProfile;
  cwd: string;
  addDirs: string[];
  systemAppend?: string;
  resumeSessionId?: string;
  images?: string[];
  /** Restrict the agent to this tool allowlist (claude-code `--allowedTools`).
   * Undefined/empty = no restriction. Used to keep weaker models focused on the
   * core editing tools instead of the full (MCP-laden) surface. */
  allowedTools?: string[];
}

export interface SpawnSpec {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface NormalizedResult {
  ok: boolean;
  subtype?: string;
  text?: string;
}

export interface EngineAdapter {
  id: EngineId;
  buildSpawn(req: SpawnRequest): SpawnSpec;
  /**
   * Tolerant: unknown/garbage lines return {kind:'raw'} or null (skip).
   * `state` is a per-attempt scratch object for engines whose protocol needs
   * accumulation across lines (e.g. codex has no single result event).
   */
  parseLine(line: string, state: Record<string, unknown>): NormalizedEvent | null;
  classify(exitCode: number | null, stderrTail: string, lastResult?: NormalizedResult): FailureClass;
}
