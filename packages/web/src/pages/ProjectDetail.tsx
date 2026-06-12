import { Link, useNavigate, useParams } from 'react-router-dom';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import type { AgentRun, PlanDocument, Project, ProjectInput, Task } from '@akb/shared';
import { api } from '../lib/api';
import { useWsTopics } from '../lib/ws';
import { formatCost, projectStatusLabel, projectStatusStyle, taskStatusStyle } from '../lib/format';

type ProjectFull = Project & { inputs: ProjectInput[]; plans: PlanDocument[] };

export default function ProjectDetail() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [rejectComment, setRejectComment] = useState('');
  const [showReject, setShowReject] = useState(false);

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<ProjectFull>(`/api/projects/${projectId}`),
  });
  const { data: planMd } = useQuery({
    queryKey: ['planMd', projectId],
    queryFn: () => api.get<{ md: string | null }>(`/api/projects/${projectId}/plan`),
    enabled: !!project && ['awaiting_approval', 'running', 'paused', 'done'].includes(project.status),
  });
  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => api.get<Task[]>(`/api/projects/${projectId}/tasks`),
  });
  const { data: runs = [] } = useQuery({
    queryKey: ['projectRuns', projectId],
    queryFn: () => api.get<AgentRun[]>(`/api/projects/${projectId}/runs`),
  });

  useWsTopics(['global', `board:${projectId}`], (msg) => {
    if (msg.type === 'project.updated' || msg.type === 'plan.ready') {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['planMd', projectId] });
    }
    if (msg.type === 'task.updated' || msg.type === 'tasks.created') {
      queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    }
    if (msg.type === 'run.updated') {
      queryClient.invalidateQueries({ queryKey: ['projectRuns', projectId] });
    }
  });

  const startPlanning = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/plan/start`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      navigate(`/projects/${projectId}/planner`);
    },
  });
  const approve = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/plan/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
  const reject = useMutation({
    mutationFn: (comment: string) => api.post(`/api/projects/${projectId}/plan/reject`, { comment }),
    onSuccess: () => {
      setShowReject(false);
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      navigate(`/projects/${projectId}/planner`);
    },
  });

  if (!project) return <div className="p-6 text-slate-400">Loading…</div>;

  const totalCost = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const doneTasks = tasks.filter((t) => t.status === 'done').length;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{project.name}</h1>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${projectStatusStyle[project.status]}`}>
            {projectStatusLabel[project.status]}
          </span>
        </div>
        <p className="mt-1 font-mono text-xs text-slate-500">
          {project.targetRepoPath}
          {project.gitBranch ? ` · ${project.gitBranch}` : ''}
        </p>
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-400">
          <span>
            Tasks: {doneTasks}/{tasks.length}
          </span>
          <span>Cost to date: {formatCost(totalCost)}</span>
        </div>
      </div>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-300">Idea</h2>
        <p className="whitespace-pre-wrap text-sm text-slate-200">{project.prompt}</p>
        {project.inputs.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {project.inputs.map((i) => (
              <span key={i.id} className="rounded-md bg-slate-800 px-2 py-1 text-xs text-slate-400">
                {i.kind === 'link' ? '🔗 ' : '📎 '}
                {i.kind === 'link' ? i.pathOrUrl : (i.originalName ?? i.pathOrUrl.split('/').pop())}
              </span>
            ))}
          </div>
        )}
      </section>

      <div className="flex flex-wrap gap-2">
        {project.status === 'draft' && (
          <button
            onClick={() => startPlanning.mutate()}
            disabled={startPlanning.isPending}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            {startPlanning.isPending ? 'Starting…' : '🧠 Start planning'}
          </button>
        )}
        {['planning', 'awaiting_answers', 'awaiting_approval'].includes(project.status) && (
          <Link
            to={`/projects/${projectId}/planner`}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-600"
          >
            💬 Planner session
          </Link>
        )}
        {tasks.length > 0 && (
          <Link
            to={`/projects/${projectId}/board`}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-600"
          >
            ▦ Board
          </Link>
        )}
      </div>

      {planMd?.md && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-300">Plan</h2>
            {project.status === 'awaiting_approval' && (
              <div className="flex gap-2">
                <button
                  onClick={() => approve.mutate()}
                  disabled={approve.isPending}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
                >
                  {approve.isPending ? 'Approving…' : '✓ Approve & start'}
                </button>
                <button
                  onClick={() => setShowReject((v) => !v)}
                  className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-600"
                >
                  ✕ Request changes
                </button>
              </div>
            )}
          </div>
          {showReject && (
            <div className="mb-3 space-y-2">
              <textarea
                value={rejectComment}
                onChange={(e) => setRejectComment(e.target.value)}
                rows={3}
                placeholder="What should change in the plan?"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm outline-none focus:border-sky-500"
              />
              <button
                onClick={() => reject.mutate(rejectComment)}
                disabled={!rejectComment.trim() || reject.isPending}
                className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
              >
                Send back to planner
              </button>
            </div>
          )}
          <div className="prose prose-sm prose-invert max-w-none">
            <ReactMarkdown>{planMd.md}</ReactMarkdown>
          </div>
        </section>
      )}

      {tasks.length > 0 && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-300">Tasks</h2>
          <ul className="space-y-1.5">
            {tasks.map((t) => (
              <li key={t.id}>
                <Link
                  to={`/tasks/${t.id}`}
                  className="flex items-center justify-between rounded-lg bg-slate-800/50 px-3 py-2 hover:bg-slate-800"
                >
                  <span className="truncate text-sm text-slate-200">{t.title}</span>
                  <span className={`ml-2 shrink-0 rounded-full px-2 py-0.5 text-[11px] ${taskStatusStyle[t.status]}`}>
                    {t.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
