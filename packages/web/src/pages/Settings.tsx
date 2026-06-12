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
import { api } from '../lib/api';

export default function Settings() {
  return (
    <div className="mx-auto max-w-3xl space-y-8 p-4 sm:p-6">
      <h1 className="text-lg font-semibold">Settings</h1>
      <ProvidersSection />
      <RolesSection />
      <SecretsSection />
      <PipelineSection />
      <NotificationsSection />
    </div>
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
  env: [{ key: 'ANTHROPIC_BASE_URL', value: '' }],
  notes: '',
});

function ProvidersSection() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

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
        env: Object.fromEntries(d.env.filter((e) => e.key.trim()).map((e) => [e.key.trim(), e.value])),
      };
      return d.id ? api.patch(`/api/providers/${d.id}`, body) : api.post('/api/providers', body);
    },
    onSuccess: () => {
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ['providers'] });
    },
  });

  const toggle = useMutation({
    mutationFn: (p: ProviderProfile) => api.patch(`/api/providers/${p.id}`, { enabled: !p.enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['providers'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/providers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['providers', 'roles'] }),
  });

  const test = useMutation({
    mutationFn: async (id: string) => ({ id, result: await api.post<{ ok: boolean; failureClass: string; resultText: string | null }>(`/api/providers/${id}/test`) }),
    onSuccess: ({ id, result }) => {
      setTestResult((s) => ({
        ...s,
        [id]: result.ok ? `✓ OK — "${result.resultText ?? ''}"`.slice(0, 80) : `✕ ${result.failureClass}: ${result.resultText ?? 'failed'}`.slice(0, 120),
      }));
      queryClient.invalidateQueries({ queryKey: ['providers'] });
    },
  });

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-300">AI Providers</h2>
        <button
          onClick={() => setDraft(emptyDraft())}
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
        >
          + Add provider
        </button>
      </div>

      <ul className="space-y-2">
        {providers.map((p) => (
          <li key={p.id} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium text-slate-100">
                  {p.name}
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{p.engine}</span>
                  {p.modelLabel && (
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{p.modelLabel}</span>
                  )}
                </p>
                {!p.enabled && (
                  <p className="mt-0.5 text-xs text-rose-400">disabled{p.disabledReason ? ` — ${p.disabledReason}` : ''}</p>
                )}
                {p.enabled && p.cooldownUntil && p.cooldownUntil > Date.now() && (
                  <p className="mt-0.5 text-xs text-amber-400">
                    cooling down until {new Date(p.cooldownUntil).toLocaleTimeString()}
                  </p>
                )}
                {testResult[p.id] && <p className="mt-0.5 text-xs text-slate-400">{testResult[p.id]}</p>}
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button
                  onClick={() => test.mutate(p.id)}
                  disabled={test.isPending}
                  className="rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-40"
                >
                  {test.isPending && test.variables === p.id ? 'Testing…' : 'Test'}
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
                  className="rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700"
                >
                  Edit
                </button>
                <button
                  onClick={() => toggle.mutate(p)}
                  className="rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700"
                >
                  {p.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete provider "${p.name}"?`)) remove.mutate(p.id);
                  }}
                  className="rounded-md bg-rose-900/60 px-2.5 py-1 text-xs text-rose-300 hover:bg-rose-800"
                >
                  ✕
                </button>
              </div>
            </div>
          </li>
        ))}
        {providers.length === 0 && (
          <p className="rounded-xl border border-dashed border-slate-700 p-4 text-center text-sm text-slate-500">
            No providers yet. Add Claude, Codex, DeepSeek, or a local endpoint.
          </p>
        )}
      </ul>

      {draft && (
        <div className="mt-3 rounded-xl border border-sky-900 bg-slate-900 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">
            {draft.id ? 'Edit provider' : 'New provider'}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-slate-400">
              Name
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="deepseek-via-claude"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100 outline-none focus:border-sky-500"
              />
            </label>
            <label className="block text-xs text-slate-400">
              Engine
              <select
                value={draft.engine}
                onChange={(e) => setDraft({ ...draft, engine: e.target.value as EngineId })}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100 outline-none focus:border-sky-500"
              >
                {ENGINES.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-slate-400 sm:col-span-2">
              Model label (codex: passed as -m)
              <input
                value={draft.modelLabel}
                onChange={(e) => setDraft({ ...draft, modelLabel: e.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100 outline-none focus:border-sky-500"
              />
            </label>
          </div>

          <p className="mb-1 mt-3 text-xs text-slate-400">
            Environment variables — values may use{' '}
            <code className="rounded bg-slate-800 px-1">{'${SECRET:NAME}'}</code>
          </p>
          {draft.env.map((row, i) => (
            <div key={i} className="mb-1.5 flex gap-1.5">
              <input
                value={row.key}
                onChange={(e) =>
                  setDraft({ ...draft, env: draft.env.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)) })
                }
                placeholder="ANTHROPIC_BASE_URL"
                className="w-2/5 rounded-lg border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-100 outline-none focus:border-sky-500"
              />
              <input
                value={row.value}
                onChange={(e) =>
                  setDraft({ ...draft, env: draft.env.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)) })
                }
                placeholder="value or ${SECRET:KEY_NAME}"
                className="flex-1 rounded-lg border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-100 outline-none focus:border-sky-500"
              />
              <button
                onClick={() => setDraft({ ...draft, env: draft.env.filter((_, j) => j !== i) })}
                className="px-2 text-slate-500 hover:text-rose-400"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            onClick={() => setDraft({ ...draft, env: [...draft.env, { key: '', value: '' }] })}
            className="text-xs text-sky-400 hover:underline"
          >
            + add variable
          </button>

          <div className="mt-4 flex gap-2">
            <button
              onClick={() => save.mutate(draft)}
              disabled={!draft.name.trim() || save.isPending}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
            >
              Save
            </button>
            <button
              onClick={() => setDraft(null)}
              className="rounded-lg bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/* --------------------------------- Roles --------------------------------- */

function RolesSection() {
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
      <h2 className="mb-1 text-sm font-semibold text-slate-300">Role → Provider priority</h2>
      <p className="mb-3 text-xs text-slate-500">
        Each agent role tries providers in order; on quota/auth failure it falls back to the next.
      </p>
      <div className="space-y-2">
        {AGENT_ROLES.map((role) => {
          const entry = roles.find((r) => r.role === role);
          const ids = entry?.profileIds ?? [];
          const unused = providers.filter((p) => !ids.includes(p.id));
          return (
            <div key={role} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">{role}</p>
              {ids.length === 0 && <p className="mb-1 text-xs text-slate-600">no providers assigned</p>}
              <ol className="space-y-1">
                {ids.map((id, i) => (
                  <li key={id} className="flex items-center gap-2 rounded-lg bg-slate-800/60 px-2.5 py-1.5">
                    <span className="w-4 text-center text-[10px] text-slate-500">{i + 1}</span>
                    <span className="flex-1 truncate text-xs text-slate-200">{byId.get(id)?.name ?? id}</span>
                    <button
                      disabled={i === 0}
                      onClick={() => {
                        const next = [...ids];
                        [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                        setOrder.mutate({ role, profileIds: next });
                      }}
                      className="px-1 text-slate-500 hover:text-slate-200 disabled:opacity-20"
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
                      className="px-1 text-slate-500 hover:text-slate-200 disabled:opacity-20"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => setOrder.mutate({ role, profileIds: ids.filter((x) => x !== id) })}
                      className="px-1 text-slate-500 hover:text-rose-400"
                    >
                      ✕
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
                  className="mt-2 rounded-lg border border-slate-700 bg-slate-950 p-1.5 text-xs text-slate-300 outline-none"
                >
                  <option value="">+ add provider…</option>
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
      <h2 className="mb-1 text-sm font-semibold text-slate-300">Secrets</h2>
      <p className="mb-3 text-xs text-slate-500">
        API keys stored in <code className="rounded bg-slate-800 px-1">data/secrets.json</code> (never in the
        database). Reference them in provider env as {'${SECRET:NAME}'}.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {(data?.names ?? []).map((n) => (
          <span key={n} className="flex items-center gap-1.5 rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">
            🔑 {n}
            <button onClick={() => remove.mutate(n)} className="text-slate-500 hover:text-rose-400">
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="DEEPSEEK_API_KEY"
          className="w-2/5 rounded-lg border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-100 outline-none focus:border-sky-500"
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          type="password"
          placeholder="sk-…"
          className="flex-1 rounded-lg border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-100 outline-none focus:border-sky-500"
        />
        <button
          onClick={() => save.mutate()}
          disabled={!name.trim() || !value || save.isPending}
          className="rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </section>
  );
}

/* -------------------------------- Pipeline -------------------------------- */

function PipelineSection() {
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

  const num = (label: string, key: keyof AppSettings, min: number, max: number) => (
    <label className="block text-xs text-slate-400">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        defaultValue={settings[key] as number}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v) && v !== settings[key]) update.mutate({ [key]: v });
        }}
        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100 outline-none focus:border-sky-500"
      />
    </label>
  );

  const toggle = (label: string, key: keyof AppSettings, hint?: string) => (
    <label className="flex items-center justify-between gap-3 rounded-lg bg-slate-800/50 px-3 py-2">
      <span>
        <span className="block text-sm text-slate-200">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={settings[key] as boolean}
        onChange={(e) => update.mutate({ [key]: e.target.checked })}
        className="h-4 w-4 accent-sky-500"
      />
    </label>
  );

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-slate-300">Pipeline</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {num('Stuck threshold (min)', 'stuckThresholdMin', 1, 240)}
        {num('Wall clock limit (min)', 'wallClockLimitMin', 1, 1440)}
        {num('Max retries', 'maxRetries', 0, 10)}
        {num('Max review bounces', 'maxBounces', 0, 10)}
        {num('Parallel tasks', 'concurrency', 1, 4)}
        {num('Max Q&A rounds', 'maxQaRounds', 1, 20)}
      </div>
      <div className="mt-3 space-y-2">
        {toggle('Auto review', 'autoAdvanceReview', 'Reviewer agent advances tasks out of To Review')}
        {toggle('Auto test', 'autoAdvanceTest', 'Tester agent advances tasks out of To Test')}
      </div>
    </section>
  );
}

/* ----------------------------- Notifications ----------------------------- */

function NotificationsSection() {
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
  const smtpDraft = smtp ?? settings.smtp ?? { host: '', port: 587, secure: false, user: '', pass: '', from: '', to: '' };

  const field = (label: string, key: keyof typeof smtpDraft, type = 'text') => (
    <label className="block text-xs text-slate-400">
      {label}
      <input
        type={type}
        value={String(smtpDraft[key] ?? '')}
        onChange={(e) =>
          setSmtp({ ...smtpDraft, [key]: type === 'number' ? Number(e.target.value) : e.target.value })
        }
        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100 outline-none focus:border-sky-500"
      />
    </label>
  );

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-slate-300">Notifications</h2>
      <div className="space-y-2">
        <label className="flex items-center justify-between rounded-lg bg-slate-800/50 px-3 py-2">
          <span className="text-sm text-slate-200">macOS banner (osascript)</span>
          <input
            type="checkbox"
            checked={settings.notifyMacos}
            onChange={(e) => update.mutate({ notifyMacos: e.target.checked })}
            className="h-4 w-4 accent-sky-500"
          />
        </label>
        <label className="flex items-center justify-between rounded-lg bg-slate-800/50 px-3 py-2">
          <span className="text-sm text-slate-200">Email (SMTP)</span>
          <input
            type="checkbox"
            checked={settings.notifyEmail}
            onChange={(e) => update.mutate({ notifyEmail: e.target.checked })}
            className="h-4 w-4 accent-sky-500"
          />
        </label>
      </div>

      {settings.notifyEmail && (
        <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900 p-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {field('Host', 'host')}
            {field('Port', 'port', 'number')}
            {field('User', 'user')}
            {field('Password', 'pass', 'password')}
            {field('From', 'from')}
            {field('To', 'to')}
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={smtpDraft.secure}
              onChange={(e) => setSmtp({ ...smtpDraft, secure: e.target.checked })}
              className="h-3.5 w-3.5 accent-sky-500"
            />
            TLS (secure)
          </label>
          <button
            onClick={() => update.mutate({ smtp: smtpDraft })}
            className="mt-3 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
          >
            Save SMTP
          </button>
        </div>
      )}

      <button
        onClick={() => testNotify.mutate()}
        className="mt-3 rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
      >
        {testNotify.isPending ? 'Sending…' : testNotify.isSuccess ? '✓ Sent' : 'Send test notification'}
      </button>
    </section>
  );
}
