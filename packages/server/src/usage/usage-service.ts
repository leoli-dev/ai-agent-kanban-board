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
      if (profile.engine === 'codex') return await this.codex(profile);

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
      if (base.includes('z.ai') || base.includes('bigmodel.cn')) return await this.zai(env, base);
      if (base.includes('minimax')) return await this.minimax(env, base);
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
   * z.ai / Zhipu GLM coding-plan quota (approach learned from CodexBar):
   * GET {host}/api/monitor/usage/quota/limit with the API token.
   */
  private async zai(env: Record<string, string>, base: string): Promise<UsageResult> {
    const key = env.ANTHROPIC_AUTH_TOKEN ?? env.ZAI_API_KEY;
    if (!key) return { unsupported: true, reason: 'no-key' };
    const host = base.includes('bigmodel.cn') ? 'https://open.bigmodel.cn' : 'https://api.z.ai';
    const res = await fetch(`${host}/api/monitor/usage/quota/limit`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `z.ai quota endpoint: HTTP ${res.status}` };
    const json = (await res.json()) as {
      data?: {
        planName?: string;
        plan?: string;
        limits?: Array<{
          type?: string;
          percentage?: number;
          usage?: number;
          currentValue?: number;
          remaining?: number;
          nextResetTime?: number;
        }>;
      };
    };
    const limits = json.data?.limits ?? [];
    const entries: UsageEntry[] = [];
    for (const limit of limits) {
      let usedPercent = limit.percentage;
      if (usedPercent == null && limit.usage && limit.usage > 0) {
        const used =
          limit.remaining != null ? limit.usage - limit.remaining : (limit.currentValue ?? 0);
        usedPercent = Math.max(0, Math.min(100, (used / limit.usage) * 100));
      }
      if (usedPercent == null) continue;
      entries.push({
        label: limit.type === 'TOKENS_LIMIT' ? 'tokensWindow' : 'timeWindow',
        usedPercent,
        resetsAt: limit.nextResetTime ? new Date(limit.nextResetTime).toISOString() : null,
      });
    }
    const plan = json.data?.planName ?? json.data?.plan;
    if (plan && entries[0]) entries[0].note = plan;
    if (!entries.length) return { error: 'no quota windows in z.ai response' };
    return { entries, fetchedAt: Date.now() };
  }

  /**
   * MiniMax coding-plan remains (approach learned from CodexBar):
   * GET {api-host}/v1/api/openplatform/coding_plan/remains with the key.
   */
  private async minimax(env: Record<string, string>, base: string): Promise<UsageResult> {
    const key = env.ANTHROPIC_AUTH_TOKEN ?? env.MINIMAX_API_KEY;
    if (!key) return { unsupported: true, reason: 'no-key' };
    const host = base.includes('minimaxi.com') ? 'https://api.minimaxi.com' : 'https://api.minimax.io';
    const res = await fetch(`${host}/v1/api/openplatform/coding_plan/remains`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `minimax remains endpoint: HTTP ${res.status}` };
    const json = (await res.json()) as {
      plan_name?: string;
      current_subscribe_title?: string;
      model_remains?: Array<{
        model_name?: string;
        current_interval_total_count?: number;
        current_interval_usage_count?: number;
        current_interval_remaining_percent?: number;
        end_time?: number;
        current_weekly_total_count?: number;
        current_weekly_usage_count?: number;
        current_weekly_remaining_percent?: number;
        weekly_end_time?: number;
      }>;
    };
    const entries: UsageEntry[] = [];
    const epochToIso = (v?: number) =>
      v ? new Date(v > 10_000_000_000 ? v : v * 1000).toISOString() : null;
    for (const m of (json.model_remains ?? []).slice(0, 3)) {
      const intervalPct =
        m.current_interval_remaining_percent != null
          ? 100 - m.current_interval_remaining_percent
          : m.current_interval_total_count
            ? ((m.current_interval_usage_count ?? 0) / m.current_interval_total_count) * 100
            : null;
      if (intervalPct != null) {
        entries.push({
          label: 'fiveHour',
          usedPercent: intervalPct,
          resetsAt: epochToIso(m.end_time),
          note: m.model_name,
        });
      }
      const weeklyPct =
        m.current_weekly_remaining_percent != null
          ? 100 - m.current_weekly_remaining_percent
          : m.current_weekly_total_count
            ? ((m.current_weekly_usage_count ?? 0) / m.current_weekly_total_count) * 100
            : null;
      if (weeklyPct != null) {
        entries.push({
          label: 'sevenDay',
          usedPercent: weeklyPct,
          resetsAt: epochToIso(m.weekly_end_time),
          note: m.model_name,
        });
      }
    }
    const plan = json.current_subscribe_title ?? json.plan_name;
    if (plan && entries[0]) entries[0].note = `${plan}${entries[0].note ? ` · ${entries[0].note}` : ''}`;
    if (!entries.length) return { error: 'no model remains in minimax response' };
    return { entries, fetchedAt: Date.now() };
  }

  /**
   * Codex subscription: OAuth credentials from ~/.codex/auth.json, refreshed
   * via auth.openai.com when stale/rejected (flow learned from CodexBar),
   * then GET chatgpt.com/backend-api/wham/usage. Falls back to scanning run
   * logs for rate-limit snapshots.
   */
  private async codex(profile: ProviderProfile): Promise<UsageResult> {
    try {
      const result = await codexOauthUsage();
      if (result) return result;
    } catch {
      /* fall back to log scan */
    }
    return this.codexFromLogs(profile);
  }

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

/* ----------------------------- Codex OAuth ----------------------------- */
/* Flow ported from steipete/CodexBar (CodexTokenRefresher/CodexOAuthUsageFetcher). */

const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_REFRESH_AFTER_MS = 8 * 24 * 3_600_000;

interface CodexAuthFile {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
  [key: string]: unknown;
}

function codexAuthPath(): string {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  return path.join(home, 'auth.json');
}

async function codexOauthUsage(): Promise<UsageResult | null> {
  const authFile = codexAuthPath();
  let auth: CodexAuthFile;
  try {
    auth = JSON.parse(fs.readFileSync(authFile, 'utf8')) as CodexAuthFile;
  } catch {
    return null; // no codex login on this machine
  }
  let tokens = auth.tokens;
  if (!tokens?.access_token) return null;

  const lastRefresh = auth.last_refresh ? Date.parse(auth.last_refresh) : 0;
  if (Date.now() - lastRefresh > CODEX_REFRESH_AFTER_MS && tokens.refresh_token) {
    tokens = (await codexRefreshTokens(authFile, auth)) ?? tokens;
  }

  let res = await codexUsageRequest(tokens);
  if (res.status === 401 && tokens.refresh_token) {
    const refreshed = await codexRefreshTokens(authFile, auth);
    if (!refreshed) return { error: 'codex token refresh failed — run `codex` to log in again' };
    tokens = refreshed;
    res = await codexUsageRequest(tokens);
  }
  if (!res.ok) return { error: `codex usage endpoint: HTTP ${res.status}` };

  const data = (await res.json()) as {
    plan_type?: string;
    rate_limit?: {
      primary_window?: { used_percent?: number; reset_at?: number };
      secondary_window?: { used_percent?: number; reset_at?: number };
    };
    credits?: { has_credits?: boolean; unlimited?: boolean; balance?: number | string };
  };
  const entries: UsageEntry[] = [];
  const epochToIso = (v?: number) =>
    v ? new Date(v > 10_000_000_000 ? v : v * 1000).toISOString() : null;
  const windows: ['primary_window' | 'secondary_window', string][] = [
    ['primary_window', 'fiveHour'],
    ['secondary_window', 'sevenDay'],
  ];
  for (const [key, label] of windows) {
    const w = data.rate_limit?.[key];
    if (w && typeof w.used_percent === 'number') {
      entries.push({ label, usedPercent: w.used_percent, resetsAt: epochToIso(w.reset_at) });
    }
  }
  if (data.credits?.has_credits && !data.credits.unlimited && data.credits.balance != null) {
    entries.push({ label: 'credits', text: String(data.credits.balance) });
  }
  if (data.plan_type && entries[0]) entries[0].note = `plan: ${data.plan_type}`;
  if (!entries.length) return { error: 'no rate limit windows in codex response' };
  return { entries, fetchedAt: Date.now() };
}

async function codexUsageRequest(tokens: NonNullable<CodexAuthFile['tokens']>) {
  return fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      accept: 'application/json',
      'user-agent': 'agent-kanban-board',
      ...(tokens.account_id ? { 'ChatGPT-Account-Id': tokens.account_id } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
}

/** Refresh and persist codex OAuth tokens (same write-back the CLI does). */
async function codexRefreshTokens(
  authFile: string,
  auth: CodexAuthFile,
): Promise<CodexAuthFile['tokens'] | null> {
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) return null;
  try {
    const res = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'openid profile email',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
    };
    const tokens = {
      ...auth.tokens,
      access_token: json.access_token ?? auth.tokens?.access_token,
      refresh_token: json.refresh_token ?? refreshToken,
      id_token: json.id_token ?? auth.tokens?.id_token,
    };
    fs.writeFileSync(
      authFile,
      JSON.stringify({ ...auth, tokens, last_refresh: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
    return tokens;
  } catch {
    return null;
  }
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
