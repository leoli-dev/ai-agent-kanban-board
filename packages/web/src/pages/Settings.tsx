import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AGENT_ROLES,
  ENGINES,
  type AgentRole,
  type EngineId,
  type ProviderProfile,
  type Settings as AppSettings,
} from '@akb/shared';
import { api, ApiError } from '../lib/api';
import { LANGS, useI18n, useT } from '../lib/i18n';
import { IconCheck, IconPlus, IconX } from '../components/icons';

export default function Settings() {
  const t = useT();
  return (
    <div className="mx-auto max-w-3xl space-y-10 p-4 sm:p-6">
      <h1 className="text-xl font-semibold tracking-tight">{t('settings.title')}</h1>
      <LanguageSection />
      <ProvidersSection />
      <RolesSection />
      <SecretsSection />
      <PipelineSection />
      <NotificationsSection />
    </div>
  );
}

function SectionHeader({ title, help }: { title: string; help?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-[15px] font-semibold text-ink-100">{title}</h2>
      {help && <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-400">{help}</p>}
    </div>
  );
}

/* -------------------------------- Language ------------------------------- */

function LanguageSection() {
  const t = useT();
  const { lang, setLang } = useI18n();
  return (
    <section>
      <SectionHeader title={t('settings.language')} help={t('settings.language.help')} />
      <div className="flex gap-1.5">
        {LANGS.map((l) => (
          <button
            key={l.id}
            onClick={() => setLang(l.id)}
            className={`btn px-4 py-2 text-sm ${
              lang === l.id ? 'btn-primary' : 'btn-ghost'
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------- Providers ------------------------------- */

interface ProfileDraft {
  id?: string;
  name: string;
  engine: EngineId;
  modelLabel: string;
  env: { key: string; value: string }[];
  notes: string;
}

const emptyDraft = (): ProfileDraft => ({
  name: '',
  engine: 'claude-code',
  modelLabel: '',
  env: [{ key: '', value: '' }],
  notes: '',
});

/** Quick-start templates for common providers. */
const PRESETS: { id: string; label: string; draft: () => ProfileDraft }[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    draft: () => ({
      ...emptyDraft(),
      name: 'anthropic',
      env: [{ key: 'ANTHROPIC_API_KEY', value: '${SECRET:ANTHROPIC_API_KEY}' }],
    }),
  },
  {
    id: 'deepseek',
    label: 'DeepSeek (via Claude Code)',
    draft: () => ({
      ...emptyDraft(),
      name: 'deepseek',
      modelLabel: 'deepseek-v4-pro',
      env: [
        { key: 'ANTHROPIC_BASE_URL', value: 'https://api.deepseek.com/anthropic' },
        { key: 'ANTHROPIC_AUTH_TOKEN', value: '${SECRET:DEEPSEEK_API_KEY}' },
        { key: 'ANTHROPIC_MODEL', value: 'deepseek-v4-pro[1m]' },
        { key: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: 'deepseek-v4-pro[1m]' },
        { key: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: 'deepseek-v4-pro[1m]' },
        { key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: 'deepseek-v4-flash' },
        { key: 'CLAUDE_CODE_SUBAGENT_MODEL', value: 'deepseek-v4-flash' },
        { key: 'CLAUDE_CODE_EFFORT_LEVEL', value: 'max' },
        { key: 'API_TIMEOUT_MS', value: '3000000' },
      ],
    }),
  },
  {
    id: 'minimax',
    label: 'MiniMax (via Claude Code)',
    draft: () => ({
      ...emptyDraft(),
      name: 'minimax',
      env: [
        { key: 'ANTHROPIC_BASE_URL', value: 'https://api.minimax.io/anthropic' },
        { key: 'ANTHROPIC_AUTH_TOKEN', value: '${SECRET:MINIMAX_API_KEY}' },
        { key: 'API_TIMEOUT_MS', value: '3000000' },
      ],
    }),
  },
  {
    id: 'local',
    label: 'Local LLM (ollama / omlx / mlx)',
    draft: () => ({
      ...emptyDraft(),
      name: 'local-llm',
      env: [
        { key: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:8000' },
        { key: 'ANTHROPIC_AUTH_TOKEN', value: 'local' },
        { key: 'ANTHROPIC_MODEL', value: 'your-model-name' },
        { key: 'API_TIMEOUT_MS', value: '3000000' },
      ],
    }),
  },
  {
    id: 'codex',
    label: 'Codex (OpenAI)',
    draft: () => ({
      ...emptyDraft(),
      name: 'codex',
      engine: 'codex',
      modelLabel: 'gpt-5.3-codex',
      env: [{ key: 'CODEX_SANDBOX', value: 'workspace-write' }],
    }),
  },
];

interface TestOutcome {
  ok: boolean;
  text: string;
}

function ProvidersSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [testResult, setTestResult] = useState<Record<string, TestOutcome | 'pending'>>({});

  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ProviderProfile[]>('/api/providers'),
  });

  const save = useMutation({
    mutationFn: async (d: ProfileDraft) => {
      const body = {
        name: d.name,
        engine: d.engine,
        modelLabel: d.modelLabel || null,
        notes: d.notes || null,
        env: Object.fromEntries(
          d.env.filter((e) => e.key.trim()).map((e) => [e.key.trim(), e.value]),
        ),
      };
      return d.id ? api.patch(`/api/providers/${d.id}`, body) : api.post('/api/providers', body);
    },
    onSuccess: () => {
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ['providers'] });
    },
  });

  const toggle = useMutation({
    mutationFn: (p: ProviderProfile) =>
      api.patch(`/api/providers/${p.id}`, { enabled: !p.enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['providers'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/providers/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] });
      queryClient.invalidateQueries({ queryKey: ['roles'] });
    },
  });

  async function runTest(id: string) {
    setTestResult((s) => ({ ...s, [id]: 'pending' }));
    try {
      const result = await api.post<{ ok: boolean; failureClass: string; resultText: string | null }>(
        `/api/providers/${id}/test`,
      );
      setTestResult((s) => ({
        ...s,
        [id]: result.ok
          ? { ok: true, text: `OK — "${(result.resultText ?? '').slice(0, 60)}"` }
          : { ok: false, text: `${result.failureClass}: ${(result.resultText ?? 'failed').slice(0, 120)}` },
      }));
    } catch (e) {
      setTestResult((s) => ({
        ...s,
        [id]: { ok: false, text: e instanceof ApiError ? `HTTP ${e.status}: ${e.message}` : String(e) },
      }));
    }
    queryClient.invalidateQueries({ queryKey: ['providers'] });
  }

  return (
    <section>
      <div className="flex items-start justify-between gap-3">
        <SectionHeader title={t('settings.providers')} help={t('settings.providers.help')} />
        <button onClick={() => setDraft(emptyDraft())} className="btn btn-primary shrink-0 px-3 py-1.5 text-xs">
          <IconPlus width={13} height={13} /> {t('settings.providers.add')}
        </button>
      </div>

      <ul className="space-y-2">
        {providers.map((p) => {
          const result = testResult[p.id];
          return (
            <li key={p.id} className="card p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-100">
                    {p.name}
                    <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-400">
                      {p.engine}
                    </span>
                    {p.modelLabel && (
                      <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-400">
                        {p.modelLabel}
                      </span>
                    )}
                  </p>
                  {!p.enabled && (
                    <p className="mt-0.5 text-xs text-red-400">
                      {t('settings.provider.disabled')}
                      {p.disabledReason ? ` — ${p.disabledReason}` : ''}
                    </p>
                  )}
                  {p.enabled && p.cooldownUntil && p.cooldownUntil > Date.now() && (
                    <p className="mt-0.5 text-xs text-accent-300">
                      {t('settings.provider.cooldown', {
                        time: new Date(p.cooldownUntil).toLocaleTimeString(),
                      })}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    onClick={() => runTest(p.id)}
                    disabled={result === 'pending'}
                    title={t('settings.provider.testHint')}
                    className="btn btn-ghost px-2.5 py-1 text-xs"
                  >
                    {result === 'pending' ? (
                      <>
                        <span className="h-3 w-3 animate-spin rounded-full border border-ink-500 border-t-accent-400" />
                        {t('common.testing')}
                      </>
                    ) : (
                      t('common.test')
                    )}
                  </button>
                  <button
                    onClick={() =>
                      setDraft({
                        id: p.id,
                        name: p.name,
                        engine: p.engine,
                        modelLabel: p.modelLabel ?? '',
                        env: Object.entries(p.env).map(([key, value]) => ({ key, value })),
                        notes: p.notes ?? '',
                      })
                    }
                    className="btn btn-ghost px-2.5 py-1 text-xs"
                  >
                    {t('common.edit')}
                  </button>
                  <button onClick={() => toggle.mutate(p)} className="btn btn-ghost px-2.5 py-1 text-xs">
                    {p.enabled ? t('common.disable') : t('common.enable')}
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(t('settings.provider.deleteConfirm', { name: p.name })))
                        remove.mutate(p.id);
                    }}
                    className="btn btn-danger px-2 py-1 text-xs"
                  >
                    <IconX width={12} height={12} />
                  </button>
                </div>
              </div>
              {result && result !== 'pending' && (
                <p
                  className={`mt-2 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-xs ${
                    result.ok ? 'bg-teal-500/10 text-teal-300' : 'bg-red-500/10 text-red-300'
                  }`}
                >
                  {result.ok ? <IconCheck width={13} height={13} /> : <IconX width={13} height={13} />}
                  {result.text}
                </p>
              )}
            </li>
          );
        })}
        {providers.length === 0 && (
          <p className="card border-dashed p-5 text-center text-sm text-ink-500">
            {t('settings.providers.empty')}
          </p>
        )}
      </ul>

      {draft && (
        <div className="card mt-3 border-accent-500/30 p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink-100">
            {draft.id ? t('settings.provider.edit') : t('settings.provider.new')}
          </h3>

          {!draft.id && (
            <div className="mb-4">
              <p className="mb-1.5 text-xs text-ink-400">{t('settings.provider.preset')}</p>
              <div className="flex flex-wrap gap-1.5">
                <button onClick={() => setDraft(emptyDraft())} className="btn btn-ghost px-2.5 py-1 text-xs">
                  {t('settings.provider.preset.custom')}
                </button>
                {PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => setDraft(preset.draft())}
                    className="btn btn-ghost px-2.5 py-1 text-xs"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-ink-400">
              {t('settings.provider.name')}
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="deepseek"
                className="input-base mt-1"
              />
            </label>
            <label className="block text-xs text-ink-400">
              {t('settings.provider.engine')}
              <select
                value={draft.engine}
                onChange={(e) => setDraft({ ...draft, engine: e.target.value as EngineId })}
                className="input-base mt-1"
              >
                {ENGINES.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
            {t('settings.provider.engine.help')}
          </p>

          <label className="mt-3 block text-xs text-ink-400">
            {t('settings.provider.model')}
            <input
              value={draft.modelLabel}
              onChange={(e) => setDraft({ ...draft, modelLabel: e.target.value })}
              className="input-base mt-1 font-mono"
            />
          </label>
          <p className="mt-1.5 text-[11px] text-ink-500">{t('settings.provider.model.help')}</p>

          <p className="mb-1 mt-4 text-xs font-medium text-ink-300">{t('settings.provider.env')}</p>
          <p className="mb-2 text-[11px] leading-relaxed text-ink-500">
            {t('settings.provider.env.help')}
          </p>
          {draft.env.map((row, i) => (
            <div key={i} className="mb-1.5 flex gap-1.5">
              <input
                value={row.key}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    env: draft.env.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)),
                  })
                }
                placeholder="ANTHROPIC_BASE_URL"
                className="input-base w-2/5 font-mono text-xs"
              />
              <input
                value={row.value}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    env: draft.env.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)),
                  })
                }
                placeholder={'value or ${SECRET:KEY_NAME}'}
                className="input-base flex-1 font-mono text-xs"
              />
              <button
                onClick={() => setDraft({ ...draft, env: draft.env.filter((_, j) => j !== i) })}
                className="px-2 text-ink-500 transition-colors hover:text-red-400"
              >
                <IconX width={13} height={13} />
              </button>
            </div>
          ))}
          <button
            onClick={() => setDraft({ ...draft, env: [...draft.env, { key: '', value: '' }] })}
            className="text-xs text-accent-300 hover:underline"
          >
            + {t('settings.provider.addVar')}
          </button>

          <div className="mt-4 flex gap-2">
            <button
              onClick={() => save.mutate(draft)}
              disabled={!draft.name.trim() || save.isPending}
              className="btn btn-primary px-4 py-2 text-sm"
            >
              {t('common.save')}
            </button>
            <button onClick={() => setDraft(null)} className="btn btn-ghost px-4 py-2 text-sm">
              {t('common.cancel')}
            </button>
          </div>
          {save.isError && (
            <p className="mt-2 text-xs text-red-300">{String((save.error as Error).message)}</p>
          )}
        </div>
      )}
    </section>
  );
}

/* --------------------------------- Roles --------------------------------- */

function RolesSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ProviderProfile[]>('/api/providers'),
  });
  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<{ role: AgentRole; profileIds: string[] }[]>('/api/roles'),
  });

  const setOrder = useMutation({
    mutationFn: ({ role, profileIds }: { role: AgentRole; profileIds: string[] }) =>
      api.put(`/api/roles/${role}`, { profileIds }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['roles'] }),
  });

  const byId = new Map(providers.map((p) => [p.id, p]));

  return (
    <section>
      <SectionHeader title={t('settings.roles')} help={t('settings.roles.help')} />
      <div className="space-y-2">
        {AGENT_ROLES.map((role) => {
          const entry = roles.find((r) => r.role === role);
          const ids = entry?.profileIds ?? [];
          const unused = providers.filter((p) => !ids.includes(p.id));
          return (
            <div key={role} className="card p-3">
              <p className="text-[13px] font-semibold text-ink-200">{t(`role.${role}`)}</p>
              <p className="mb-2 mt-0.5 text-[11px] leading-relaxed text-ink-500">
                {t(`role.${role}.hint`)}
              </p>
              {ids.length === 0 && (
                <p className="mb-1 text-xs italic text-ink-600">{t('settings.roles.none')}</p>
              )}
              <ol className="space-y-1">
                {ids.map((id, i) => (
                  <li key={id} className="flex items-center gap-2 rounded-lg bg-ink-850 px-2.5 py-1.5">
                    <span className="w-4 text-center font-mono text-[10px] text-ink-500 tabular">
                      {i + 1}
                    </span>
                    <span className="flex-1 truncate text-xs text-ink-200">
                      {byId.get(id)?.name ?? id}
                    </span>
                    <button
                      disabled={i === 0}
                      onClick={() => {
                        const next = [...ids];
                        [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                        setOrder.mutate({ role, profileIds: next });
                      }}
                      className="px-1 text-ink-500 transition-colors hover:text-ink-200 disabled:opacity-20"
                    >
                      ↑
                    </button>
                    <button
                      disabled={i === ids.length - 1}
                      onClick={() => {
                        const next = [...ids];
                        [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
                        setOrder.mutate({ role, profileIds: next });
                      }}
                      className="px-1 text-ink-500 transition-colors hover:text-ink-200 disabled:opacity-20"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => setOrder.mutate({ role, profileIds: ids.filter((x) => x !== id) })}
                      className="px-1 text-ink-500 transition-colors hover:text-red-400"
                    >
                      <IconX width={12} height={12} />
                    </button>
                  </li>
                ))}
              </ol>
              {unused.length > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) setOrder.mutate({ role, profileIds: [...ids, e.target.value] });
                  }}
                  className="input-base mt-2 w-auto py-1.5 text-xs"
                >
                  <option value="">+ {t('settings.roles.add')}</option>
                  {unused.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* -------------------------------- Secrets -------------------------------- */

function SecretsSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  const { data } = useQuery({
    queryKey: ['secrets'],
    queryFn: () => api.get<{ names: string[] }>('/api/secrets'),
  });

  const save = useMutation({
    mutationFn: () => api.put(`/api/secrets/${encodeURIComponent(name.trim())}`, { value }),
    onSuccess: () => {
      setName('');
      setValue('');
      queryClient.invalidateQueries({ queryKey: ['secrets'] });
    },
  });
  const remove = useMutation({
    mutationFn: (n: string) => api.delete(`/api/secrets/${encodeURIComponent(n)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['secrets'] }),
  });

  return (
    <section>
      <SectionHeader title={t('settings.secrets')} help={t('settings.secrets.help')} />
      <div className="flex flex-wrap gap-1.5">
        {(data?.names ?? []).map((n) => (
          <span
            key={n}
            className="flex items-center gap-1.5 rounded-lg bg-ink-800 px-3 py-1 font-mono text-xs text-ink-300"
          >
            {n}
            <button
              onClick={() => remove.mutate(n)}
              className="text-ink-500 transition-colors hover:text-red-400"
            >
              <IconX width={11} height={11} />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="DEEPSEEK_API_KEY"
          className="input-base w-2/5 font-mono text-xs"
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          type="password"
          placeholder="sk-…"
          className="input-base flex-1 font-mono text-xs"
        />
        <button
          onClick={() => save.mutate()}
          disabled={!name.trim() || !value || save.isPending}
          className="btn btn-primary px-3 py-2 text-xs"
        >
          {t('common.save')}
        </button>
      </div>
    </section>
  );
}

/* -------------------------------- Pipeline -------------------------------- */

function PipelineSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<AppSettings>('/api/settings'),
  });
  const update = useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api.patch('/api/settings', patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });

  if (!settings) return null;

  const num = (labelKey: string, helpKey: string, key: keyof AppSettings, min: number, max: number) => (
    <div className="card p-3">
      <label className="block text-xs font-medium text-ink-300">
        {t(labelKey)}
        <input
          type="number"
          min={min}
          max={max}
          defaultValue={settings[key] as number}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (!Number.isNaN(v) && v !== settings[key]) update.mutate({ [key]: v });
          }}
          className="input-base mt-1.5 font-mono tabular"
        />
      </label>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">{t(helpKey)}</p>
    </div>
  );

  const toggle = (labelKey: string, helpKey: string, key: keyof AppSettings) => (
    <label className="card flex items-start justify-between gap-3 p-3">
      <span>
        <span className="block text-sm font-medium text-ink-200">{t(labelKey)}</span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-500">{t(helpKey)}</span>
      </span>
      <input
        type="checkbox"
        checked={settings[key] as boolean}
        onChange={(e) => update.mutate({ [key]: e.target.checked })}
        className="mt-1 h-4 w-4 accent-[#f5b942]"
      />
    </label>
  );

  return (
    <section>
      <SectionHeader title={t('settings.pipeline')} help={t('settings.pipeline.help')} />
      <div className="grid gap-2 sm:grid-cols-2">
        {num('settings.stuck', 'settings.stuck.help', 'stuckThresholdMin', 1, 240)}
        {num('settings.wallclock', 'settings.wallclock.help', 'wallClockLimitMin', 1, 1440)}
        {num('settings.retries', 'settings.retries.help', 'maxRetries', 0, 10)}
        {num('settings.bounces', 'settings.bounces.help', 'maxBounces', 0, 10)}
        {num('settings.concurrency', 'settings.concurrency.help', 'concurrency', 1, 4)}
        {num('settings.qaRounds', 'settings.qaRounds.help', 'maxQaRounds', 1, 20)}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {toggle('settings.autoReview', 'settings.autoReview.help', 'autoAdvanceReview')}
        {toggle('settings.autoTest', 'settings.autoTest.help', 'autoAdvanceTest')}
      </div>
    </section>
  );
}

/* ----------------------------- Notifications ----------------------------- */

function NotificationsSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<AppSettings>('/api/settings'),
  });
  const update = useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api.patch('/api/settings', patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });
  const testNotify = useMutation({ mutationFn: () => api.post('/api/notifications/test') });

  const [smtp, setSmtp] = useState<NonNullable<AppSettings['smtp']> | null>(null);
  if (!settings) return null;
  const smtpDraft =
    smtp ?? settings.smtp ?? { host: '', port: 587, secure: false, user: '', pass: '', from: '', to: '' };

  const field = (labelKey: string, key: keyof typeof smtpDraft, type = 'text') => (
    <label className="block text-xs text-ink-400">
      {t(labelKey)}
      <input
        type={type}
        value={String(smtpDraft[key] ?? '')}
        onChange={(e) =>
          setSmtp({ ...smtpDraft, [key]: type === 'number' ? Number(e.target.value) : e.target.value })
        }
        className="input-base mt-1"
      />
    </label>
  );

  return (
    <section>
      <SectionHeader title={t('settings.notifications')} help={t('settings.notifications.help')} />
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="card flex items-start justify-between gap-3 p-3">
          <span>
            <span className="block text-sm font-medium text-ink-200">{t('settings.notify.macos')}</span>
            <span className="mt-0.5 block text-[11px] text-ink-500">{t('settings.notify.macos.help')}</span>
          </span>
          <input
            type="checkbox"
            checked={settings.notifyMacos}
            onChange={(e) => update.mutate({ notifyMacos: e.target.checked })}
            className="mt-1 h-4 w-4 accent-[#f5b942]"
          />
        </label>
        <label className="card flex items-start justify-between gap-3 p-3">
          <span>
            <span className="block text-sm font-medium text-ink-200">{t('settings.notify.email')}</span>
            <span className="mt-0.5 block text-[11px] text-ink-500">{t('settings.notify.email.help')}</span>
          </span>
          <input
            type="checkbox"
            checked={settings.notifyEmail}
            onChange={(e) => update.mutate({ notifyEmail: e.target.checked })}
            className="mt-1 h-4 w-4 accent-[#f5b942]"
          />
        </label>
      </div>

      {settings.notifyEmail && (
        <div className="card mt-2 p-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {field('settings.smtp.host', 'host')}
            {field('settings.smtp.port', 'port', 'number')}
            {field('settings.smtp.user', 'user')}
            {field('settings.smtp.pass', 'pass', 'password')}
            {field('settings.smtp.from', 'from')}
            {field('settings.smtp.to', 'to')}
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-ink-400">
            <input
              type="checkbox"
              checked={smtpDraft.secure}
              onChange={(e) => setSmtp({ ...smtpDraft, secure: e.target.checked })}
              className="h-3.5 w-3.5 accent-[#f5b942]"
            />
            {t('settings.smtp.tls')}
          </label>
          <button
            onClick={() => update.mutate({ smtp: smtpDraft })}
            className="btn btn-primary mt-3 px-3 py-1.5 text-xs"
          >
            {t('settings.smtp.save')}
          </button>
        </div>
      )}

      <button onClick={() => testNotify.mutate()} className="btn btn-ghost mt-3 px-3 py-1.5 text-xs">
        {testNotify.isPending
          ? t('settings.notify.sending')
          : testNotify.isSuccess
            ? `✓ ${t('settings.notify.sent')}`
            : t('settings.notify.send')}
      </button>
    </section>
  );
}
