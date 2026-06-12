import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Project } from '@akb/shared';
import { api } from '../lib/api';
import { useWsTopics } from '../lib/ws';
import { useT } from '../lib/i18n';
import { projectStatusStyle } from '../lib/format';
import { Loading, LoadError } from '../components/QueryState';
import { IconFolder, IconPlus } from '../components/icons';

interface ProjectCard extends Project {
  stats: { total: number; done: number; failed: number; blocked: number; inFlight: number; percent: number };
  needsAttention: 'answers' | 'approval' | 'blocked' | 'failed' | null;
  runtimeMs: number;
}

function runtime(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const attentionStyle: Record<string, string> = {
  answers: 'border-accent-400/60 bg-accent-500/15 text-accent-200',
  approval: 'border-accent-400/60 bg-accent-500/15 text-accent-200',
  blocked: 'border-orange-500/50 bg-orange-500/10 text-orange-300',
  failed: 'border-red-500/50 bg-red-500/10 text-red-300',
};

export default function Projects() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: projects = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectCard[]>('/api/projects'),
    refetchInterval: 30_000,
  });

  useWsTopics(['global'], (msg) => {
    if (
      msg.type === 'project.updated' ||
      msg.type === 'task.updated' ||
      msg.type === 'tasks.created' ||
      msg.type === 'task.deleted'
    ) {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    }
  });

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">{t('projects.title')}</h1>
        <Link to="/projects/new" className="btn btn-primary px-4 py-2 text-sm">
          <IconPlus width={15} height={15} /> {t('projects.new')}
        </Link>
      </div>

      {isLoading ? (
        <Loading />
      ) : isError ? (
        <LoadError error={error} onRetry={refetch} />
      ) : projects.length === 0 ? (
        <div className="card rise-in border-dashed p-12 text-center">
          <IconFolder className="mx-auto mb-3 text-ink-500" width={32} height={32} />
          <p className="font-medium text-ink-200">{t('projects.empty.title')}</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-400">{t('projects.empty.body')}</p>
          <Link to="/projects/new" className="btn btn-primary mx-auto mt-5 px-4 py-2 text-sm">
            <IconPlus width={15} height={15} /> {t('projects.new')}
          </Link>
        </div>
      ) : (
        <div className="columns-1 gap-3 sm:columns-2 lg:columns-3 [&>*]:mb-3">
          {projects.map((p, i) => (
            <Link
              key={p.id}
              to={`/projects/${p.id}`}
              style={{ animationDelay: `${i * 35}ms` }}
              className="card rise-in block break-inside-avoid p-4 transition-all duration-150 hover:-translate-y-px hover:border-ink-600"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="min-w-0 text-[15px] font-semibold leading-snug text-ink-100">
                  {p.name.length > 60 ? p.name.slice(0, 60) + '…' : p.name}
                </h2>
                <span
                  className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ${projectStatusStyle[p.status]}`}
                >
                  {t(`status.${p.status}`)}
                </span>
              </div>

              <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-ink-400">{p.prompt}</p>

              {p.needsAttention && (
                <p
                  className={`mt-3 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${attentionStyle[p.needsAttention]}`}
                >
                  {t(`projects.needs.${p.needsAttention}`)}
                </p>
              )}

              {p.stats.total > 0 && (
                <div className="mt-3">
                  <div className="flex items-baseline justify-between font-mono text-[11px] text-ink-400 tabular">
                    <span>
                      {t('projects.tasks', { done: p.stats.done, total: p.stats.total })}
                    </span>
                    <span className="text-ink-300">{p.stats.percent}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-950">
                    <div
                      className={`h-full rounded-full transition-all ${p.status === 'done' ? 'bg-teal-500' : 'bg-accent-400'}`}
                      style={{ width: `${Math.max(2, p.stats.percent)}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-1.5 font-mono text-[10px] tabular">
                {p.stats.done > 0 && (
                  <span className="rounded bg-teal-500/15 px-1.5 py-0.5 text-teal-300">
                    ✓ {p.stats.done}
                  </span>
                )}
                {p.stats.inFlight > 0 && (
                  <span className="rounded bg-accent-500/15 px-1.5 py-0.5 text-accent-300">
                    ▸ {p.stats.inFlight}
                  </span>
                )}
                {p.stats.failed > 0 && (
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-300">
                    ✕ {p.stats.failed}
                  </span>
                )}
                {p.stats.blocked > 0 && (
                  <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-orange-300">
                    ⛔ {p.stats.blocked}
                  </span>
                )}
                <span className="ml-auto text-ink-500">
                  {t('projects.runtime', { time: runtime(p.runtimeMs) })}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
