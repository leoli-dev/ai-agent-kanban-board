import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Project } from '@akb/shared';
import { api } from '../lib/api';
import { useWsTopics } from '../lib/ws';
import { projectStatusLabel, projectStatusStyle, timeAgo } from '../lib/format';

export default function Projects() {
  const queryClient = useQueryClient();
  const { data: projects = [], isLoading } = useQuery({
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
        <h1 className="text-lg font-semibold">Projects</h1>
        <Link
          to="/projects/new"
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
        >
          + New Project
        </Link>
      </div>

      {isLoading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : projects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 p-10 text-center">
          <p className="text-slate-400">No projects yet.</p>
          <p className="mt-1 text-sm text-slate-500">
            Start with an idea — the planner agent will turn it into an executable plan.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                to={`/projects/${p.id}`}
                className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 hover:border-slate-600"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-100">{p.name}</p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {p.targetRepoPath} · {timeAgo(p.createdAt)}
                  </p>
                </div>
                <span
                  className={`ml-3 shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${projectStatusStyle[p.status]}`}
                >
                  {projectStatusLabel[p.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
