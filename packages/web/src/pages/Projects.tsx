import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Project } from '@akb/shared';
import { api } from '../lib/api';
import { useWsTopics } from '../lib/ws';
import { useT } from '../lib/i18n';
import { projectStatusStyle, timeAgo } from '../lib/format';
import { Loading, LoadError } from '../components/QueryState';
import { IconFolder, IconPlus } from '../components/icons';

export default function Projects() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: projects = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<Project[]>('/api/projects'),
  });

  useWsTopics(['global'], (msg) => {
    if (msg.type === 'project.updated') {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    }
  });

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
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
        <ul className="space-y-2">
          {projects.map((p, i) => (
            <li key={p.id} className="rise-in" style={{ animationDelay: `${i * 35}ms` }}>
              <Link
                to={`/projects/${p.id}`}
                className="card flex items-center justify-between px-4 py-3.5 transition-all duration-150 hover:-translate-y-px hover:border-ink-700 hover:bg-ink-850"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink-100">{p.name}</p>
                  <p className="mt-0.5 truncate font-mono text-xs text-ink-500">
                    {p.targetRepoPath} · {timeAgo(p.createdAt)}
                  </p>
                </div>
                <span
                  className={`ml-3 shrink-0 rounded-md px-2.5 py-1 text-xs font-medium ${projectStatusStyle[p.status]}`}
                >
                  {t(`status.${p.status}`)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
