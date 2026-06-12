import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { readClaudeOauthToken } from '../usage/usage-service.js';

/**
 * Live model discovery for Anthropic-compatible (and OpenAI-style) backends.
 * Most vendors expose a model list next to their messages endpoint:
 *   anthropic:  https://api.anthropic.com/v1/models
 *   deepseek:   https://api.deepseek.com/models
 *   moonshot:   https://api.moonshot.ai/v1/models   (base .../anthropic stripped)
 *   local omlx/ollama/LM Studio: {base}/v1/models
 * We try a small set of candidate URLs with both auth header styles.
 */
export async function modelRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/models/list', async (req, reply) => {
    const body = z.object({ env: z.record(z.string(), z.string()) }).parse(req.body);

    // Tolerant resolve: a missing secret just means "no key yet" — the
    // OAuth/CLI-credential fallbacks below may still work.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.env)) {
      try {
        env[k] = ctx.secrets.resolveEnv({ [k]: v })[k]!;
      } catch {
        /* skip unresolved */
      }
    }

    let key = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? env.OPENAI_API_KEY ?? '';
    const base = (env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '');

    // Subscription (CLI login) profiles have no key: reuse the Claude CLI's
    // OAuth token, which api.anthropic.com/v1/models accepts.
    let oauthBeta = false;
    if (!key && base.includes('api.anthropic.com')) {
      const token = await readClaudeOauthToken();
      if (token) {
        key = token;
        oauthBeta = true;
      }
    }
    if (!key && base.includes('api.openai.com')) {
      // Codex CLI logins sometimes carry an API key in auth.json.
      try {
        const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
        const auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')) as {
          OPENAI_API_KEY?: string | null;
        };
        if (auth.OPENAI_API_KEY) key = auth.OPENAI_API_KEY;
      } catch {
        /* no codex login */
      }
    }
    if (!key && !base.startsWith('http://')) {
      return reply.code(400).send({ error: 'no API key or CLI credentials available for this endpoint' });
    }
    const roots = new Set<string>([base]);
    // Vendors usually serve models from the API root, not the /anthropic shim.
    roots.add(base.replace(/\/(anthropic|api\/anthropic|api\/v2\/apps\/claude-code-proxy)$/, ''));

    const candidates: string[] = [];
    for (const root of roots) {
      candidates.push(`${root}/v1/models`, `${root}/models`);
    }

    const errors: string[] = [];
    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          headers: {
            ...(key && !oauthBeta ? { 'x-api-key': key } : {}),
            ...(key ? { authorization: `Bearer ${key}` } : {}),
            ...(oauthBeta ? { 'anthropic-beta': 'oauth-2025-04-20' } : {}),
            'anthropic-version': '2023-06-01',
          },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          errors.push(`${url}: HTTP ${res.status}`);
          continue;
        }
        const json = (await res.json()) as { data?: { id?: string }[]; models?: { id?: string }[] };
        const items = json.data ?? json.models ?? [];
        const ids = items.map((m) => m.id).filter((x): x is string => typeof x === 'string');
        if (ids.length > 0) return { models: [...new Set(ids)].sort(), source: url };
        errors.push(`${url}: empty list`);
      } catch (err) {
        errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return reply.code(502).send({ error: errors.join('; ').slice(0, 500) });
  });
}
