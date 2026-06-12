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
  /** Tolerant: unknown/garbage lines return {kind:'raw'} or null (skip). */
  parseLine(line: string): NormalizedEvent | null;
  classify(exitCode: number | null, stderrTail: string, lastResult?: NormalizedResult): FailureClass;
}
