import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentRun } from '@akb/shared';
import { api } from '../lib/api';
import { useWsTopics } from '../lib/ws';
import { useT } from '../lib/i18n';
import { formatClock, formatCost, timeAgo } from '../lib/format';
import { Loading, LoadError } from '../components/QueryState';

interface ActivityRun extends AgentRun {
  providerName: string;
  modelLabel: string | null;
  taskTitle: string | null;
  projectName: string | null;
}

interface ActivityData {
  runs: ActivityRun[];
  byProvider: {
    providerProfileId: string;
    providerName: string;
    modelLabel: string | null;
    runs: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }[];
  totals: { runs: number; failed: number; costUsd: number };
}

const statusDot: Record<string, string> = {
  running: 'bg-teal-400 animate-pulse',
  succeeded: 'bg-teal-500',
  failed: 'bg-red-500',
  stuck: 'bg-orange-500',
  killed: 'bg-ink-500',
  interrupted: 'bg-ink-600',
};

function tokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function duration(run: AgentRun): string {
  const end = run.endedAt ?? Date.now();
  const s = Math.max(0, Math.round((end - run.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
}

export default function Activity() {
  const t = useT();
  const queryClient = useQueryClient();
  const [failedOnly, setFailedOnly] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['activity'],
    queryFn: () => api.get<ActivityData>('/api/activity'),
    refetchInterval: 15_000,
  });

  useWsTopics(['global'], (msg) => {
    if (msg.type === 'run.updated' || msg.type === 'run.started') {
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    }
  });

  if (isLoading) return <Loading />;
  if (isError || !data) return <LoadError error={error} onRetry={refetch} />;

  const rows = failedOnly
    ? data.runs.filter((r) => ['failed', 'stuck', 'killed'].includes(r.status))
    : data.runs;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <h1 className="text-xl font-semibold tracking-tight">{t('activity.title')}</h1>

      <div className="grid grid-cols-3 gap-2">
        <div className="card p-3 text-center">
          <p className="font-mono text-xl text-ink-100 tabular">{formatCost(data.totals.costUsd)}</p>
          <p className="mt-0.5 text-xs text-ink-500">{t('activity.totalCost')}</p>
        </div>
        <div className="card p-3 text-center">
          <p className="font-mono text-xl text-ink-100 tabular">{data.totals.runs}</p>
          <p className="mt-0.5 text-xs text-ink-500">{t('activity.totalRuns')}</p>
        </div>
        <div className="card p-3 text-center">
          <p className={`font-mono text-xl tabular ${data.totals.failed > 0 ? 'text-red-300' : 'text-ink-100'}`}>
            {data.totals.failed}
          </p>
          <p className="mt-0.5 text-xs text-ink-500">{t('activity.failedRuns')}</p>
        </div>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-300">{t('activity.byModel')}</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-left font-mono text-xs tabular">
            <thead>
              <tr className="border-b border-ink-800 text-ink-500">
                <th className="px-3 py-2 font-medium">{t('activity.colModel')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('activity.colRuns')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('activity.colFailed')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('activity.colTokens')} ↓/↑</th>
                <th className="px-3 py-2 text-right font-medium">{t('activity.colCost')}</th>
              </tr>
            </thead>
            <tbody>
              {data.byProvider.map((p) => (
                <tr key={p.providerProfileId} className="border-b border-ink-850 last:border-0">
                  <td className="px-3 py-2 text-ink-200">
                    {p.providerName}
                    {p.modelLabel && <span className="ml-1.5 text-ink-500">{p.modelLabel}</span>}
                  </td>
                  <td className="px-3 py-2 text-right text-ink-300">{p.runs}</td>
                  <td className={`px-3 py-2 text-right ${p.failed > 0 ? 'text-red-300' : 'text-ink-500'}`}>
                    {p.failed}
                  </td>
                  <td className="px-3 py-2 text-right text-ink-300">
                    {tokens(p.inputTokens)} / {tokens(p.outputTokens)}
                  </td>
                  <td className="px-3 py-2 text-right text-ink-200">{formatCost(p.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-300">{t('activity.recent')}</h2>
          <label className="flex items-center gap-1.5 text-xs text-ink-400">
            <input
              type="checkbox"
              checked={failedOnly}
              onChange={(e) => setFailedOnly(e.target.checked)}
              className="h-3.5 w-3.5 accent-[#f5b942]"
            />
            {t('activity.failedOnly')}
          </label>
        </div>
        {rows.length === 0 ? (
          <p className="card border-dashed p-6 text-center text-sm text-ink-500">
            {t('activity.empty')}
          </p>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-left font-mono text-xs tabular">
              <thead>
                <tr className="border-b border-ink-800 text-ink-500">
                  <th className="px-3 py-2 font-medium">{t('activity.colTime')}</th>
                  <th className="px-3 py-2 font-medium">{t('activity.colWhat')}</th>
                  <th className="px-3 py-2 font-medium">{t('activity.colRole')}</th>
                  <th className="px-3 py-2 font-medium">{t('activity.colModel')}</th>
                  <th className="px-3 py-2 font-medium">{t('activity.colStatus')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('activity.colDuration')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('activity.colTokens')} ↓/↑</th>
                  <th className="px-3 py-2 text-right font-medium">{t('activity.colCost')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-ink-850 last:border-0 hover:bg-ink-850/50">
                    <td
                      className="whitespace-nowrap px-3 py-2"
                      title={new Date(r.startedAt).toLocaleString()}
                    >
                      <div className="text-ink-300">{formatClock(r.startedAt)}</div>
                      <div className="text-[10px] text-ink-600">{timeAgo(r.startedAt)}</div>
                    </td>
                    <td className="max-w-52 px-3 py-2">
                      {r.taskId && r.taskTitle ? (
                        <Link to={`/tasks/${r.taskId}`} className="block truncate text-ink-200 hover:text-accent-300">
                          {r.taskTitle}
                        </Link>
                      ) : r.projectId ? (
                        <Link to={`/projects/${r.projectId}`} className="block truncate text-ink-200 hover:text-accent-300">
                          {r.projectName ?? r.projectId}
                        </Link>
                      ) : (
                        <span className="text-ink-500">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-300">{t(`role.${r.role}`)}</td>
                    <td className="max-w-44 truncate px-3 py-2 text-ink-300">
                      {r.providerName}
                      {r.modelLabel && <span className="ml-1 text-ink-500">{r.modelLabel}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`h-2 w-2 rounded-full ${statusDot[r.status] ?? 'bg-ink-500'}`} />
                        <span className="text-ink-300">{r.status}</span>
                        {r.failureClass && r.failureClass !== 'OK' && (
                          <span className="rounded bg-ink-800 px-1 py-0.5 text-[10px] text-accent-300">
                            {r.failureClass}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-ink-400">{duration(r)}</td>
                    <td className="px-3 py-2 text-right text-ink-400">
                      {tokens(r.inputTokens)} / {tokens(r.outputTokens)}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-200">{formatCost(r.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
