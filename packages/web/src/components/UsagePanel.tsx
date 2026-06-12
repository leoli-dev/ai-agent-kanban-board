import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';

interface UsageEntry {
  label: string;
  usedPercent?: number;
  resetsAt?: string | null;
  text?: string;
  note?: string;
}

type UsageResult =
  | { entries: UsageEntry[]; fetchedAt: number }
  | { unsupported: true; reason?: string }
  | { error: string };

function resetIn(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function barColor(pct: number): string {
  if (pct >= 90) return 'bg-red-500';
  if (pct >= 70) return 'bg-accent-400';
  return 'bg-teal-500';
}

export function UsagePanel({ providerId }: { providerId: string }) {
  const t = useT();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['usage', providerId],
    queryFn: () => api.get<UsageResult>(`/api/providers/${providerId}/usage`),
    staleTime: 60_000,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-lg bg-ink-850 px-3 py-2 text-xs text-ink-400">
        <span className="h-3 w-3 animate-spin rounded-full border border-ink-600 border-t-accent-400" />
        {t('usage.loading')}
      </div>
    );
  }
  if (isError || !data) {
    return (
      <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
        {String((error as Error)?.message ?? 'failed')}
      </p>
    );
  }
  if ('unsupported' in data) {
    const reasonKey =
      data.reason === 'api-key'
        ? 'usage.unsupported.apiKey'
        : data.reason === 'no-cli-login'
          ? 'usage.unsupported.noLogin'
          : data.reason === 'codex-no-data'
            ? 'usage.unsupported.codex'
            : data.reason === 'no-key'
              ? 'usage.unsupported.noKey'
              : 'usage.unsupported';
    return <p className="mt-2 rounded-lg bg-ink-850 px-3 py-2 text-xs text-ink-400">{t(reasonKey)}</p>;
  }
  if ('error' in data) {
    return (
      <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{data.error}</p>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg bg-ink-850 p-3">
      {data.entries.map((entry, i) => (
        <div key={i}>
          <div className="flex items-baseline justify-between gap-2 font-mono text-[11px] tabular">
            <span className="text-ink-300">
              {t(`usage.window.${entry.label}`) !== `usage.window.${entry.label}`
                ? t(`usage.window.${entry.label}`)
                : entry.label}
            </span>
            <span className="text-ink-400">
              {entry.usedPercent != null && `${entry.usedPercent.toFixed(0)}%`}
              {entry.text && (entry.usedPercent != null ? ` · ${entry.text}` : entry.text)}
              {entry.resetsAt && (
                <span className="text-ink-500"> · {t('usage.resets', { time: resetIn(entry.resetsAt) })}</span>
              )}
            </span>
          </div>
          {entry.usedPercent != null && (
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-950">
              <div
                className={`h-full rounded-full transition-all ${barColor(entry.usedPercent)}`}
                style={{ width: `${Math.min(100, Math.max(2, entry.usedPercent))}%` }}
              />
            </div>
          )}
          {entry.note && <p className="mt-0.5 text-[10px] text-ink-500">{entry.note}</p>}
        </div>
      ))}
    </div>
  );
}
