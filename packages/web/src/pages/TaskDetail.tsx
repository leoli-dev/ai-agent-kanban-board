import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentRun, Project, ProviderProfile, Task } from '@akb/shared';
import { api } from '../lib/api';
import { useWsTopics } from '../lib/ws';
import { useT } from '../lib/i18n';
import { formatCost, taskStatusStyle, timeAgo } from '../lib/format';
import { Loading, LoadError } from '../components/QueryState';
import { LogStream } from '../components/LogStream';
import { IconArrowLeft, IconRetry, IconStop, IconX } from '../components/icons';

export default function TaskDetail() {
  const t = useT();
  const { taskId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const { data: task, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.get<Task>(`/api/tasks/${taskId}`),
  });
  const { data: runs = [] } = useQuery({
    queryKey: ['taskRuns', taskId],
    queryFn: () => api.get<AgentRun[]>(`/api/tasks/${taskId}/runs`),
  });
  const { data: project } = useQuery({
    queryKey: ['projectBasic', task?.projectId],
    queryFn: () => api.get<Project>(`/api/projects/${task!.projectId}`),
    enabled: !!task,
  });
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ProviderProfile[]>('/api/providers'),
  });
  const providerById = new Map(providers.map((p) => [p.id, p]));

  useWsTopics(task ? [`board:${task.projectId}`] : [], (msg) => {
    if (msg.type === 'task.updated' && msg.task.id === taskId) {
      queryClient.setQueryData(['task', taskId], msg.task);
    }
    if (msg.type === 'run.started' || msg.type === 'run.updated') {
      queryClient.invalidateQueries({ queryKey: ['taskRuns', taskId] });
    }
  });

  const retry = useMutation({
    mutationFn: () => api.post(`/api/tasks/${taskId}/retry`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      queryClient.invalidateQueries({ queryKey: ['taskRuns', taskId] });
    },
  });
  const kill = useMutation({
    mutationFn: (runId: string) => api.post(`/api/runs/${runId}/kill`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['taskRuns', taskId] }),
  });
  const removeTask = useMutation({
    mutationFn: () => api.delete(`/api/tasks/${taskId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      navigate(task ? `/projects/${task.projectId}` : '/projects');
    },
  });

  if (isLoading) return <Loading />;
  if (isError || !task) return <LoadError error={error} onRetry={refetch} />;

  const activeRun = runs.find((r) => r.status === 'running');
  const shownRun = selectedRunId
    ? runs.find((r) => r.id === selectedRunId)
    : (activeRun ?? runs[0]);
  const totalCost = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <div>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-semibold leading-tight tracking-tight">{task.title}</h1>
          <span className={`rounded-md px-2.5 py-1 text-xs font-medium ${taskStatusStyle[task.status]}`}>
            {t(`task.${task.status}`)}
          </span>
          {activeRun && (
            <span className="flex items-center gap-1.5 text-xs text-teal-300">
              <span className="h-2 w-2 animate-pulse rounded-full bg-teal-400" />
              {t('task.agentRunning')}
            </span>
          )}
        </div>
        {project && (
          <Link
            to={`/projects/${project.id}`}
            className="mt-1 flex w-fit items-center gap-1 text-xs text-accent-300 hover:underline"
          >
            <IconArrowLeft width={12} height={12} /> {project.name}
          </Link>
        )}
        <div className="mt-2 flex flex-wrap gap-4 font-mono text-xs text-ink-400 tabular">
          <span>
            {t('common.retries')}: {task.retryCount}
          </span>
          <span>
            {t('common.bounces')}: {task.bounceCount}
          </span>
          <span>
            {t('common.cost')}: {formatCost(totalCost)}
          </span>
        </div>
        {task.blockedReason && (
          <p className="mt-2 rounded-lg border border-orange-800/60 bg-orange-950/40 p-2.5 text-xs text-orange-300">
            {t('task.blockedLabel', { reason: task.blockedReason })}
          </p>
        )}
      </div>

      <section className="card p-4">
        <h2 className="mb-2 text-sm font-semibold text-ink-300">{t('task.description')}</h2>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-200">{task.description}</p>
        {task.acceptanceCriteria.length > 0 && (
          <>
            <h3 className="mb-1 mt-3 text-xs font-semibold text-ink-400">{t('task.criteria')}</h3>
            <ul className="list-inside list-disc space-y-0.5 text-sm text-ink-300">
              {task.acceptanceCriteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <div className="flex flex-wrap gap-2">
        {activeRun ? (
          <button
            onClick={() => kill.mutate(activeRun.id)}
            disabled={kill.isPending}
            className="btn btn-danger px-4 py-2 text-sm"
          >
            <IconStop width={15} height={15} /> {t('task.kill')}
          </button>
        ) : (
          ['failed', 'blocked', 'wip'].includes(task.status) && (
            <button
              onClick={() => retry.mutate()}
              disabled={retry.isPending}
              className="btn btn-primary px-4 py-2 text-sm"
            >
              <IconRetry width={15} height={15} /> {t('task.retry')}
            </button>
          )
        )}
        <button
          onClick={() => {
            if (confirm(t('task.deleteConfirm', { title: task.title }))) removeTask.mutate();
          }}
          disabled={removeTask.isPending}
          className="btn btn-danger ml-auto px-4 py-2 text-sm"
        >
          <IconX width={15} height={15} /> {t('task.delete')}
        </button>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-300">
          {shownRun ? t('task.logRun', { id: shownRun.id.slice(0, 6) }) : t('task.log')}
        </h2>
        {shownRun ? (
          <LogStream runId={shownRun.id} active={shownRun.status === 'running'} />
        ) : (
          <p className="text-sm text-ink-500">{t('task.noRuns')}</p>
        )}
      </section>

      {runs.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-ink-300">{t('task.runHistory')}</h2>
          <ul className="space-y-1.5">
            {runs.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setSelectedRunId(r.id)}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left font-mono text-xs transition-colors duration-150 ${
                    shownRun?.id === r.id
                      ? 'border-accent-500/50 bg-accent-500/10'
                      : 'border-ink-800 bg-ink-900 hover:border-ink-600'
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <RunStatusDot status={r.status} />
                    <span className="text-ink-300">{t(`role.${r.role}`)}</span>
                    <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300">
                      {providerById.get(r.providerProfileId)?.name ?? r.providerProfileId.slice(0, 6)}
                      {providerById.get(r.providerProfileId)?.modelLabel && (
                        <span className="text-ink-500"> · {providerById.get(r.providerProfileId)!.modelLabel}</span>
                      )}
                    </span>
                    <span className="text-ink-500">{timeAgo(r.startedAt)}</span>
                    {r.failureClass && r.failureClass !== 'OK' && (
                      <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-accent-300">
                        {r.failureClass}
                      </span>
                    )}
                  </span>
                  <span className="text-ink-500 tabular">{formatCost(r.costUsd)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function RunStatusDot({ status }: { status: AgentRun['status'] }) {
  const color =
    status === 'running'
      ? 'bg-teal-400 animate-pulse'
      : status === 'succeeded'
        ? 'bg-teal-500'
        : status === 'stuck'
          ? 'bg-orange-500'
          : status === 'killed'
            ? 'bg-ink-500'
            : 'bg-red-500';
  return <span className={`h-2 w-2 rounded-full ${color}`} />;
}
