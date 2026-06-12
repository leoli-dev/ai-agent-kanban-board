import { Link, useNavigate, useParams } from 'react-router-dom';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import type { AgentRun, PlanDocument, Project, ProjectInput, Task } from '@akb/shared';
import { api } from '../lib/api';
import { useWsTopics } from '../lib/ws';
import { useT } from '../lib/i18n';
import { formatCost, projectStatusStyle, taskStatusStyle } from '../lib/format';
import { Loading, LoadError } from '../components/QueryState';
import { IconBoard, IconChat, IconSpark } from '../components/icons';

type ProjectFull = Project & { inputs: ProjectInput[]; plans: PlanDocument[] };

export default function ProjectDetail() {
  const t = useT();
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [rejectComment, setRejectComment] = useState('');
  const [showReject, setShowReject] = useState(false);

  const { data: project, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<ProjectFull>(`/api/projects/${projectId}`),
  });
  const { data: planMd } = useQuery({
    queryKey: ['planMd', projectId],
    queryFn: () => api.get<{ md: string | null }>(`/api/projects/${projectId}/plan`),
    enabled:
      !!project && ['awaiting_approval', 'running', 'paused', 'done'].includes(project.status),
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
    mutationFn: (comment: string) =>
      api.post(`/api/projects/${projectId}/plan/reject`, { comment }),
    onSuccess: () => {
      setShowReject(false);
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      navigate(`/projects/${projectId}/planner`);
    },
  });

  if (isLoading) return <Loading />;
  if (isError || !project) return <LoadError error={error} onRetry={refetch} />;

  const totalCost = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const doneTasks = tasks.filter((x) => x.status === 'done').length;

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <div>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
          <span
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${projectStatusStyle[project.status]}`}
          >
            {t(`status.${project.status}`)}
          </span>
        </div>
        <p className="mt-1 font-mono text-xs text-ink-500">
          {project.targetRepoPath}
          {project.gitBranch ? ` · ${project.gitBranch}` : ''}
        </p>
        <div className="mt-2 flex flex-wrap gap-4 font-mono text-xs text-ink-400 tabular">
          <span>{t('projects.tasks', { done: doneTasks, total: tasks.length })}</span>
          <span>{t('project.costToDate', { cost: formatCost(totalCost) })}</span>
        </div>
      </div>

      <section className="card p-4">
        <h2 className="mb-2 text-sm font-semibold text-ink-300">{t('project.idea')}</h2>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-200">{project.prompt}</p>
        {project.inputs.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {project.inputs.map((i) => (
              <span key={i.id} className="rounded-md bg-ink-800 px-2 py-1 text-xs text-ink-400">
                {i.kind === 'link'
                  ? i.pathOrUrl
                  : (i.originalName ?? i.pathOrUrl.split('/').pop())}
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
            className="btn btn-primary px-4 py-2 text-sm"
          >
            <IconSpark width={15} height={15} />
            {startPlanning.isPending ? t('project.starting') : t('project.startPlanning')}
          </button>
        )}
        {['planning', 'awaiting_answers', 'awaiting_approval'].includes(project.status) && (
          <Link to={`/projects/${projectId}/planner`} className="btn btn-ghost px-4 py-2 text-sm">
            <IconChat width={15} height={15} /> {t('project.plannerSession')}
          </Link>
        )}
        {tasks.length > 0 && (
          <Link to={`/projects/${projectId}/board`} className="btn btn-ghost px-4 py-2 text-sm">
            <IconBoard width={15} height={15} /> {t('project.board')}
          </Link>
        )}
      </div>

      {startPlanning.isError && (
        <p className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-300">
          {String((startPlanning.error as Error).message)}
        </p>
      )}

      {planMd?.md && (
        <section className="card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink-300">{t('project.plan')}</h2>
            {project.status === 'awaiting_approval' && (
              <div className="flex gap-2">
                <button
                  onClick={() => approve.mutate()}
                  disabled={approve.isPending}
                  className="btn btn-primary px-3.5 py-1.5 text-xs font-semibold"
                >
                  {approve.isPending ? t('project.approving') : t('project.approve')}
                </button>
                <button
                  onClick={() => setShowReject((v) => !v)}
                  className="btn btn-danger px-3.5 py-1.5 text-xs font-semibold"
                >
                  {t('project.requestChanges')}
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
                placeholder={t('project.rejectPlaceholder')}
                className="input-base"
              />
              <button
                onClick={() => reject.mutate(rejectComment)}
                disabled={!rejectComment.trim() || reject.isPending}
                className="btn btn-danger px-3.5 py-1.5 text-xs font-semibold"
              >
                {t('project.sendBack')}
              </button>
            </div>
          )}
          <div className="prose prose-sm prose-invert max-w-none prose-headings:tracking-tight">
            <ReactMarkdown>{planMd.md}</ReactMarkdown>
          </div>
        </section>
      )}

      {tasks.length > 0 && (
        <section className="card p-4">
          <h2 className="mb-2 text-sm font-semibold text-ink-300">{t('project.tasks')}</h2>
          <ul className="space-y-1.5">
            {tasks.map((x) => (
              <li key={x.id}>
                <Link
                  to={`/tasks/${x.id}`}
                  className="flex items-center justify-between rounded-lg bg-ink-850 px-3 py-2.5 transition-colors hover:bg-ink-800"
                >
                  <span className="truncate text-sm text-ink-200">{x.title}</span>
                  <span
                    className={`ml-2 shrink-0 rounded-md px-2 py-0.5 text-[11px] ${taskStatusStyle[x.status]}`}
                  >
                    {t(`task.${x.status}`)}
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
