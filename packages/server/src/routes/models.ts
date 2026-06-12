import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

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

    let env: Record<string, string>;
    try {
      env = ctx.secrets.resolveEnv(body.env);
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }

    const key = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? env.OPENAI_API_KEY ?? '';
    const base = (env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
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
            ...(key ? { 'x-api-key': key, authorization: `Bearer ${key}` } : {}),
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
