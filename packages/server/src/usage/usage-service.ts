import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProviderProfile } from '@akb/shared';
import type { SecretStore } from '../providers/secrets.js';
import type { RunStore } from '../runner/run-store.js';

const execFileAsync = promisify(execFile);

export interface UsageEntry {
  /** i18n key suffix rendered by the client (usage.window.*) or raw label. */
  label: string;
  usedPercent?: number;
  resetsAt?: string | null;
  text?: string;
  note?: string;
}

export type UsageResult =
  | { entries: UsageEntry[]; fetchedAt: number }
  | { unsupported: true; reason?: string }
  | { error: string };

/**
 * Per-vendor subscription/quota introspection. Every path here is
 * best-effort: vendors expose usage differently (or not at all), and some
 * endpoints are undocumented — failures degrade to a readable message.
 */
export class UsageService {
  constructor(
    private secrets: SecretStore,
    private runStore: RunStore,
  ) {}

  async forProfile(profile: ProviderProfile): Promise<UsageResult> {
    try {
      const env = this.safeResolve(profile.env);
      if (profile.engine === 'codex') return this.codexFromLogs(profile);

      const base = (env.ANTHROPIC_BASE_URL ?? '').toLowerCase();
      if (!base || base.includes('api.anthropic.com')) {
        if (env.ANTHROPIC_API_KEY) {
          return {
            unsupported: true,
            reason: 'api-key',
          };
        }
        return await this.claudeSubscription();
      }
      if (base.includes('openrouter.ai')) return await this.openrouter(env);
      if (base.includes('deepseek.com')) return await this.deepseek(env);
      if (base.includes('moonshot.')) return await this.moonshot(env, base);
      return { unsupported: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Resolve ${SECRET:..} refs but tolerate missing ones (treat as absent). */
  private safeResolve(env: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      try {
        out[k] = this.secrets.resolveEnv({ [k]: v })[k]!;
      } catch {
        /* missing secret: skip key */
      }
    }
    return out;
  }

  /**
   * Claude subscription (CLI OAuth login): token from macOS Keychain
   * ("Claude Code-credentials") or ~/.claude/.credentials.json, then the
   * oauth usage endpoint that powers Claude Code's own /usage screen.
   * Undocumented — shape parsed defensively.
   */
  private async claudeSubscription(): Promise<UsageResult> {
    const token = await readClaudeOauthToken();
    if (!token) {
      return { unsupported: true, reason: 'no-cli-login' };
    }
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `usage endpoint: HTTP ${res.status}` };
    const data = (await res.json()) as Record<string, unknown>;

    const entries: UsageEntry[] = [];
    const windows: [string, string][] = [
      ['five_hour', 'fiveHour'],
      ['seven_day', 'sevenDay'],
      ['seven_day_opus', 'sevenDayOpus'],
      ['seven_day_sonnet', 'sevenDaySonnet'],
    ];
    for (const [key, label] of windows) {
      const w = data[key] as { utilization?: number; resets_at?: string | null } | null;
      if (w && typeof w.utilization === 'number' && (w.utilization > 0 || w.resets_at)) {
        entries.push({ label, usedPercent: w.utilization, resetsAt: w.resets_at ?? null });
      }
    }
    const extra = data.extra_usage as
      | { is_enabled?: boolean; utilization?: number; used_credits?: number; monthly_limit?: number; currency?: string }
      | null;
    if (extra?.is_enabled && typeof extra.utilization === 'number') {
      entries.push({
        label: 'extraCredits',
        usedPercent: extra.utilization,
        text: `${((extra.used_credits ?? 0) / 100).toFixed(2)} / ${((extra.monthly_limit ?? 0) / 100).toFixed(0)} ${extra.currency ?? ''}`,
      });
    }
    if (entries.length === 0) return { error: 'no usage windows in response' };
    return { entries, fetchedAt: Date.now() };
  }

  /** OpenRouter: documented key endpoint with credit usage + limits. */
  private async openrouter(env: Record<string, string>): Promise<UsageResult> {
    const key = env.ANTHROPIC_AUTH_TOKEN ?? env.OPENROUTER_API_KEY;
    if (!key) return { unsupported: true, reason: 'no-key' };
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `openrouter key endpoint: HTTP ${res.status}` };
    const { data } = (await res.json()) as {
      data: { usage?: number; limit?: number | null; limit_remaining?: number | null; is_free_tier?: boolean };
    };
    const entries: UsageEntry[] = [
      {
        label: 'credits',
        text:
          data.limit != null
            ? `$${(data.usage ?? 0).toFixed(2)} / $${data.limit.toFixed(2)}`
            : `$${(data.usage ?? 0).toFixed(2)} used`,
        usedPercent:
          data.limit != null && data.limit > 0 ? ((data.usage ?? 0) / data.limit) * 100 : undefined,
      },
    ];
    return { entries, fetchedAt: Date.now() };
  }

  /** DeepSeek: documented balance endpoint. */
  private async deepseek(env: Record<string, string>): Promise<UsageResult> {
    const key = env.ANTHROPIC_AUTH_TOKEN ?? env.DEEPSEEK_API_KEY;
    if (!key) return { unsupported: true, reason: 'no-key' };
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `deepseek balance: HTTP ${res.status}` };
    const data = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: { currency?: string; total_balance?: string }[];
    };
    const info = data.balance_infos?.[0];
    if (!info) return { error: 'no balance info' };
    return {
      entries: [{ label: 'balance', text: `${info.total_balance} ${info.currency ?? ''}` }],
      fetchedAt: Date.now(),
    };
  }

  /** Moonshot/Kimi: balance endpoint at the API root. */
  private async moonshot(env: Record<string, string>, base: string): Promise<UsageResult> {
    const key = env.ANTHROPIC_AUTH_TOKEN ?? env.MOONSHOT_API_KEY;
    if (!key) return { unsupported: true, reason: 'no-key' };
    const root = base.replace(/\/anthropic\/?$/, '');
    const res = await fetch(`${root}/v1/users/me/balance`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `moonshot balance: HTTP ${res.status}` };
    const { data } = (await res.json()) as { data?: { available_balance?: number } };
    if (data?.available_balance == null) return { error: 'no balance info' };
    return {
      entries: [{ label: 'balance', text: `¥${data.available_balance.toFixed(2)}` }],
      fetchedAt: Date.now(),
    };
  }

  /**
   * Codex subscription limits: the backend endpoint rejects external calls,
   * but codex emits rate-limit snapshots in its JSON event stream. Scan the
   * most recent codex run logs for the latest snapshot.
   */
  private codexFromLogs(profile: ProviderProfile): UsageResult {
    const runs = this.runStore
      .listRunning()
      .concat(this.recentRunsForProfile(profile.id))
      .filter((r) => r.providerProfileId === profile.id);
    for (const run of runs) {
      const snapshot = scanLogForRateLimits(run.logPath);
      if (snapshot) {
        return {
          entries: snapshot.map((s) => ({
            ...s,
            note: `run ${new Date(run.lastEventAt).toLocaleString()}`,
          })),
          fetchedAt: run.lastEventAt,
        };
      }
    }
    return { unsupported: true, reason: 'codex-no-data' };
  }

  private recentRunsForProfile(profileId: string) {
    // RunStore has per-task/project queries; for usage we just need the most
    // recent runs of this profile — walk the data dir is overkill, so reuse
    // listRunning + any runs the store can give us cheaply.
    return this.runStore.listByProfile(profileId, 10);
  }
}

/** Parse codex rate_limits from an NDJSON log (legacy + thread formats). */
function scanLogForRateLimits(logPath: string): UsageEntry[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter((l) => l.includes('rate_limit'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!) as Record<string, any>;
      const rl = obj.msg?.rate_limits ?? obj.rate_limits ?? obj.usage?.rate_limits;
      if (!rl) continue;
      const entries: UsageEntry[] = [];
      for (const [key, label] of [
        ['primary', 'fiveHour'],
        ['secondary', 'sevenDay'],
      ] as const) {
        const w = rl[key];
        if (w && typeof w.used_percent === 'number') {
          entries.push({
            label,
            usedPercent: w.used_percent,
            resetsAt:
              typeof w.resets_in_seconds === 'number'
                ? new Date(Date.now() + w.resets_in_seconds * 1000).toISOString()
                : null,
          });
        }
      }
      if (entries.length) return entries;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

async function readClaudeOauthToken(): Promise<string | null> {
  // macOS Keychain first (where Claude Code stores OAuth credentials).
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-s',
        'Claude Code-credentials',
        '-w',
      ]);
      const creds = JSON.parse(stdout.trim()) as {
        claudeAiOauth?: { accessToken?: string; expiresAt?: number };
      };
      const oauth = creds.claudeAiOauth;
      if (oauth?.accessToken && (!oauth.expiresAt || oauth.expiresAt > Date.now())) {
        return oauth.accessToken;
      }
    } catch {
      /* fall through */
    }
  }
  try {
    const file = path.join(os.homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string };
    };
    return creds.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}
