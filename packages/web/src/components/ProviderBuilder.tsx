import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useT } from '../lib/i18n';
import { ModelPicker } from './ModelPicker';
import {
  buildProvider,
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
  CODEX_SANDBOXES,
  initialBuilderState,
  PROVIDER_TYPES,
  type BuilderState,
  type ProviderTypeId,
} from '../lib/provider-catalog';
import { IconCheck } from './icons';

/** Segmented single-choice control. */
function Segmented({
  options,
  value,
  onChange,
  labels,
}: {
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  labels?: Record<string, string>;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg bg-ink-950 p-1">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`rounded-md px-3 py-1.5 text-xs transition-colors duration-150 ${
            value === opt
              ? 'bg-accent-400 font-medium text-ink-950'
              : 'text-ink-400 hover:bg-ink-800 hover:text-ink-200'
          }`}
        >
          {labels?.[opt] ?? opt}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-ink-300">{label}</p>
      {children}
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-ink-500">{hint}</p>}
    </div>
  );
}

/** Live OpenRouter model catalog with static fallback. */
function useOpenRouterModels(enabled: boolean, fallback: string[]): string[] {
  const { data } = useQuery({
    queryKey: ['openrouter-models'],
    enabled,
    staleTime: 60 * 60_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch('https://openrouter.ai/api/v1/models');
      if (!res.ok) throw new Error('openrouter unreachable');
      const json = (await res.json()) as { data: { id: string }[] };
      return json.data.map((m) => m.id).sort();
    },
  });
  return data && data.length > 0 ? data : fallback;
}

export function ProviderBuilder({
  onClose,
  onCustom,
}: {
  onClose: () => void;
  /** Open the raw env-var editor instead (Custom card). */
  onCustom: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [state, setState] = useState<BuilderState | null>(null);
  const [showEnv, setShowEnv] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const type = state ? PROVIDER_TYPES.find((x) => x.id === state.typeId)! : null;
  const openRouterModels = useOpenRouterModels(
    state?.typeId === 'openrouter',
    PROVIDER_TYPES.find((x) => x.id === 'openrouter')!.models,
  );

  // Re-derive base URL when region flips.
  useEffect(() => {
    if (!state || !type?.baseUrl) return;
    const url = state.region === 'cn' && type.baseUrl.cn ? type.baseUrl.cn : type.baseUrl.intl;
    if (state.typeId !== 'local' && state.baseUrl !== url) setState({ ...state, baseUrl: url });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.region, state?.typeId]);

  const built = useMemo(() => (state && type ? buildProvider(state) : null), [state, type]);

  const fetchModels = useMutation({
    mutationFn: async () => {
      if (!built || !type) return [];
      // Codex lists models from the OpenAI API root; claude engines from
      // their (Anthropic-compatible) base URL.
      const env =
        type.engine === 'codex'
          ? {
              ANTHROPIC_BASE_URL: 'https://api.openai.com',
              ANTHROPIC_AUTH_TOKEN: '${SECRET:OPENAI_API_KEY}',
            }
          : { ...built.env };
      const res = await api.post<{ models: string[] }>('/api/models/list', { env });
      return res.models;
    },
    onSuccess: (models) => {
      setFetchError(null);
      if (models.length) setFetchedModels(models);
    },
    onError: (err) => {
      setFetchError(err instanceof ApiError ? err.message : String(err));
    },
  });

  // Reset fetched list when switching provider type.
  useEffect(() => {
    setFetchedModels(null);
    setFetchError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.typeId]);

  const save = useMutation({
    mutationFn: async () => {
      if (!built) return;
      if (built.secret) {
        await api.put(`/api/secrets/${encodeURIComponent(built.secret.name)}`, {
          value: built.secret.value,
        });
      }
      await api.post('/api/providers', {
        name: built.name,
        engine: built.engine,
        modelLabel: built.modelLabel,
        env: built.env,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] });
      queryClient.invalidateQueries({ queryKey: ['secrets'] });
      onClose();
    },
  });

  /* ---------- step 1: pick a provider type ---------- */
  if (!state || !type) {
    return (
      <div className="card mt-3 border-accent-500/30 p-4">
        <h3 className="mb-1 text-sm font-semibold text-ink-100">{t('builder.pick')}</h3>
        <p className="mb-3 text-xs text-ink-500">{t('builder.pick.help')}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {PROVIDER_TYPES.map((p) => (
            <button
              key={p.id}
              onClick={() => (p.id === 'custom' ? onCustom() : setState(initialBuilderState(p.id)))}
              className="card flex items-center gap-3 p-3 text-left transition-all duration-150 hover:-translate-y-px hover:border-accent-500/50"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink-800 text-lg text-accent-300">
                {p.emoji}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink-100">{p.label}</span>
                <span className="block truncate text-[11px] text-ink-500">{p.vendor}</span>
              </span>
            </button>
          ))}
        </div>
        <button onClick={onClose} className="btn btn-ghost mt-4 px-4 py-2 text-sm">
          {t('common.cancel')}
        </button>
      </div>
    );
  }

  /* ---------- step 2: configure with controls ---------- */
  const isCodex = type.engine === 'codex';
  const effortOptions = isCodex ? CODEX_EFFORT_LEVELS : CLAUDE_EFFORT_LEVELS;
  const baseModels = state.typeId === 'openrouter' ? openRouterModels : type.models;
  const models = fetchedModels
    ? [...(baseModels.includes('(default)') ? ['(default)'] : []), ...fetchedModels]
    : baseModels;
  const showModelPicker = models.length > 0 || state.typeId === 'local';
  const canFetchModels = state.typeId !== 'openrouter';
  const canSave =
    state.name.trim().length > 0 && (state.typeId !== 'local' || state.baseUrl.trim().length > 0);

  return (
    <div className="card mt-3 border-accent-500/30 p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-100">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-ink-800 text-accent-300">
            {type.emoji}
          </span>
          {type.label}
          <span className="text-xs font-normal text-ink-500">· {type.vendor}</span>
        </h3>
        <button onClick={() => setState(null)} className="text-xs text-accent-300 hover:underline">
          ← {t('builder.changeType')}
        </button>
      </div>

      <div className="space-y-4">
        <Field label={t('settings.provider.name')}>
          <input
            value={state.name}
            onChange={(e) => setState({ ...state, name: e.target.value })}
            className="input-base max-w-xs"
            placeholder={type.id}
          />
        </Field>

        {type.hasCliAuth && (
          <Field label={t('builder.auth')} hint={t('builder.auth.help')}>
            <Segmented
              options={['cli', 'key']}
              value={state.auth}
              onChange={(v) => setState({ ...state, auth: v as 'cli' | 'key' })}
              labels={{ cli: t('builder.auth.cli'), key: t('builder.auth.key') }}
            />
          </Field>
        )}

        {type.secretName && (!type.hasCliAuth || state.auth === 'key') && (
          <Field
            label={t('builder.apiKey')}
            hint={t('builder.apiKey.help', { name: type.secretName })}
          >
            <input
              type="password"
              value={state.apiKey}
              onChange={(e) => setState({ ...state, apiKey: e.target.value })}
              placeholder="sk-…"
              className="input-base max-w-md font-mono"
            />
          </Field>
        )}

        {type.baseUrl?.cn && (
          <Field label={t('builder.region')}>
            <Segmented
              options={['intl', 'cn']}
              value={state.region}
              onChange={(v) => setState({ ...state, region: v as 'intl' | 'cn' })}
              labels={{ intl: t('builder.region.intl'), cn: t('builder.region.cn') }}
            />
          </Field>
        )}

        {state.typeId === 'local' && (
          <>
            <Field label={t('builder.baseUrl')} hint={t('builder.baseUrl.help')}>
              <input
                value={state.baseUrl}
                onChange={(e) => setState({ ...state, baseUrl: e.target.value })}
                className="input-base max-w-md font-mono"
                placeholder="http://127.0.0.1:8000"
              />
            </Field>
            <Field label={t('builder.localToken')} hint={t('builder.localToken.help')}>
              <input
                value={state.localToken}
                onChange={(e) => setState({ ...state, localToken: e.target.value })}
                className="input-base max-w-xs font-mono"
              />
            </Field>
          </>
        )}

        {showModelPicker && (
          <Field
            label={t('builder.model')}
            hint={
              state.typeId === 'openrouter'
                ? t('builder.model.openrouter')
                : state.typeId === 'local'
                  ? t('builder.model.local.help')
                  : t('builder.model.pickerHint')
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-64 flex-1">
                <ModelPicker
                  models={models}
                  value={state.model}
                  onChange={(m) => setState({ ...state, model: m })}
                  placeholder={
                    state.typeId === 'local' ? 'Qwen3.6-35B-A3B-MLX-8bit' : t('builder.model.search')
                  }
                />
              </div>
              {canFetchModels && (
                <button
                  type="button"
                  onClick={() => fetchModels.mutate()}
                  disabled={fetchModels.isPending}
                  className="btn btn-ghost px-3 py-2 text-xs"
                  title={t('builder.model.fetch.help')}
                >
                  {fetchModels.isPending ? (
                    <span className="h-3 w-3 animate-spin rounded-full border border-ink-500 border-t-accent-400" />
                  ) : (
                    '↻'
                  )}
                  {t('builder.model.fetch')}
                </button>
              )}
            </div>
            {fetchedModels && (
              <p className="mt-1 text-[11px] text-teal-300">
                {t('builder.model.fetched', { n: fetchedModels.length })}
              </p>
            )}
            {fetchError && <p className="mt-1 text-[11px] text-red-300">{fetchError}</p>}
          </Field>
        )}

        {type.hasEffort !== false && state.typeId !== 'custom' && state.typeId !== 'local' && (
          <Field
            label={t('builder.effort')}
            hint={isCodex ? t('builder.effort.codex') : t('builder.effort.claude')}
          >
            <Segmented
              options={effortOptions}
              value={state.effort}
              onChange={(v) => setState({ ...state, effort: v })}
              labels={{ '(default)': t('builder.default') }}
            />
          </Field>
        )}

        {isCodex && (
          <Field label={t('builder.sandbox')} hint={t('builder.sandbox.help')}>
            <Segmented
              options={CODEX_SANDBOXES}
              value={state.sandbox}
              onChange={(v) => setState({ ...state, sandbox: v })}
            />
          </Field>
        )}

        {built && (
          <div>
            <button
              onClick={() => setShowEnv((v) => !v)}
              className="text-xs text-accent-300 hover:underline"
            >
              {showEnv ? '▾' : '▸'} {t('builder.preview')}
            </button>
            {showEnv && (
              <pre className="mt-2 overflow-x-auto rounded-lg bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-ink-300">
                {`engine: ${built.engine}${built.modelLabel ? `\nmodel:  ${built.modelLabel}` : ''}\n` +
                  Object.entries(built.env)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('\n')}
              </pre>
            )}
          </div>
        )}
      </div>

      <div className="mt-5 flex items-center gap-2">
        <button
          onClick={() => save.mutate()}
          disabled={!canSave || save.isPending}
          className="btn btn-primary px-4 py-2 text-sm"
        >
          <IconCheck width={14} height={14} />
          {save.isPending ? t('common.loading') : t('builder.create')}
        </button>
        <button onClick={onClose} className="btn btn-ghost px-4 py-2 text-sm">
          {t('common.cancel')}
        </button>
        {save.isError && (
          <p className="text-xs text-red-300">{String((save.error as Error).message)}</p>
        )}
      </div>
    </div>
  );
}
