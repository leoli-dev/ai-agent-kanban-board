import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentRun, Project, Task } from '@akb/shared';
import { api } from '../lib/api';
import { useWsTopics } from '../lib/ws';
import { formatCost, taskStatusStyle, timeAgo } from '../lib/format';
import { LogStream } from '../components/LogStream';

export default function TaskDetail() {
  const { taskId = '' } = useParams();
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const { data: task } = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.get<Task>(`/api/tasks/${taskId}`),
  });
  const { data: runs = [] } = useQuery({
    queryKey: ['taskRuns', taskId],
    queryFn: () => api.get<AgentRun[]>(`/api/tasks/${taskId}/runs`),
  });
  const { data: project } = useQuery({
    queryKey: ['project', task?.projectId],
    queryFn: () => api.get<Project>(`/api/projects/${task!.projectId}`),
    enabled: !!task,
  });

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

  if (!task) return <div className="p-6 text-slate-400">Loading…</div>;

  const activeRun = runs.find((r) => r.status === 'running');
  const shownRun = selectedRunId ? runs.find((r) => r.id === selectedRunId) : (activeRun ?? runs[0]);
  const totalCost = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{task.title}</h1>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${taskStatusStyle[task.status]}`}>
            {task.status}
          </span>
          {activeRun && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" /> agent running
            </span>
          )}
        </div>
        {project && (
          <Link to={`/projects/${project.id}`} className="text-xs text-sky-400 hover:underline">
            ← {project.name}
          </Link>
        )}
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-400">
          <span>retries: {task.retryCount}</span>
          <span>bounces: {task.bounceCount}</span>
          <span>cost: {formatCost(totalCost)}</span>
        </div>
        {task.blockedReason && (
          <p className="mt-2 rounded-lg border border-orange-800 bg-orange-950/40 p-2 text-xs text-orange-300">
            Blocked: {task.blockedReason}
          </p>
        )}
      </div>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-300">Description</h2>
        <p className="whitespace-pre-wrap text-sm text-slate-200">{task.description}</p>
        {task.acceptanceCriteria.length > 0 && (
          <>
            <h3 className="mb-1 mt-3 text-xs font-semibold text-slate-400">Acceptance criteria</h3>
            <ul className="list-inside list-disc space-y-0.5 text-sm text-slate-300">
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
            className="rounded-lg bg-rose-700 px-4 py-2 text-sm font-medium text-white hover:bg-rose-600 disabled:opacity-40"
          >
            ◼ Kill agent
          </button>
        ) : (
          ['failed', 'blocked', 'wip'].includes(task.status) && (
            <button
              onClick={() => retry.mutate()}
              disabled={retry.isPending}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
            >
              ↻ Retry task
            </button>
          )
        )}
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-300">
            {shownRun ? `Log — run ${shownRun.id.slice(0, 6)}` : 'Log'}
          </h2>
        </div>
        {shownRun ? (
          <LogStream runId={shownRun.id} active={shownRun.status === 'running'} />
        ) : (
          <p className="text-sm text-slate-500">No runs yet for this task.</p>
        )}
      </section>

      {runs.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-300">Run history</h2>
          <ul className="space-y-1.5">
            {runs.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setSelectedRunId(r.id)}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs ${
                    shownRun?.id === r.id
                      ? 'border-sky-700 bg-sky-950/40'
                      : 'border-slate-800 bg-slate-900 hover:border-slate-600'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <RunStatusDot status={r.status} />
                    <span className="text-slate-300">{r.role}</span>
                    <span className="text-slate-500">{timeAgo(r.startedAt)}</span>
                    {r.failureClass && r.failureClass !== 'OK' && (
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-amber-400">
                        {r.failureClass}
                      </span>
                    )}
                  </span>
                  <span className="text-slate-500">{formatCost(r.costUsd)}</span>
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
      ? 'bg-emerald-400 animate-pulse'
      : status === 'succeeded'
        ? 'bg-emerald-500'
        : status === 'stuck'
          ? 'bg-orange-500'
          : status === 'killed'
            ? 'bg-slate-500'
            : 'bg-rose-500';
  return <span className={`h-2 w-2 rounded-full ${color}`} />;
}
