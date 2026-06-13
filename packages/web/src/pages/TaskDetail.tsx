import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentRun, Project, ProviderProfile, Task } from '@akb/shared';
import { api } from '../lib/api';
import { Markdown } from '../components/Markdown';
import { useWsTopics } from '../lib/ws';
import { useT } from '../lib/i18n';
import { formatCost, taskStatusStyle, timeAgo } from '../lib/format';
import { Loading, LoadError } from '../components/QueryState';
import { LogStream } from '../components/LogStream';
import { IconArrowLeft, IconBoard, IconRetry, IconStop, IconX } from '../components/icons';

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
  const { data: artifacts } = useQuery({
    queryKey: ['taskArtifacts', taskId],
    queryFn: () =>
      api.get<{
        review: { verdict: string; notes?: string } | null;
        testReport: { pass: boolean; summary?: string } | null;
        feedback: string | null;
        diagnoses: string[];
      }>(`/api/tasks/${taskId}/artifacts`),
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
              {t(`role.${activeRun.role}`)} · {t('task.agentRunning')}
              <span className="rounded-md bg-teal-500/15 px-2 py-0.5 font-mono text-[11px] text-teal-200">
                {providerById.get(activeRun.providerProfileId)?.name ?? '…'}
                {providerById.get(activeRun.providerProfileId)?.modelLabel && (
                  <span className="text-teal-400/70">
                    {' '}
                    · {providerById.get(activeRun.providerProfileId)!.modelLabel}
                  </span>
                )}
              </span>
            </span>
          )}
        </div>
        {project && (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-2">
              <Link to={`/projects/${project.id}`} className="btn btn-ghost px-3 py-1.5 text-xs">
                <IconArrowLeft width={13} height={13} /> {t('task.backToProject')}
              </Link>
              <Link to={`/projects/${project.id}/board`} className="btn btn-ghost px-3 py-1.5 text-xs">
                <IconBoard width={13} height={13} /> {t('task.backToBoard')}
              </Link>
            </div>
            <IdeaBox idea={project.prompt} />
          </div>
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

      <StageSummaries
        runs={runs}
        artifacts={artifacts}
        providerName={(id) => {
          const p = providerById.get(id);
          return p ? `${p.name}${p.modelLabel ? ` · ${p.modelLabel}` : ''}` : id.slice(0, 6);
        }}
      />

      <section>
        <h2 className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-ink-300">
          {shownRun ? t('task.logRun', { id: shownRun.id.slice(0, 6) }) : t('task.log')}
          {shownRun && (
            <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] font-normal text-ink-400">
              {providerById.get(shownRun.providerProfileId)?.name}
              {providerById.get(shownRun.providerProfileId)?.modelLabel &&
                ` · ${providerById.get(shownRun.providerProfileId)!.modelLabel}`}
            </span>
          )}
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

/** What each stage produced, attributed to the model that did it. */
function StageSummaries({
  runs,
  artifacts,
  providerName,
}: {
  runs: AgentRun[];
  artifacts?: {
    review: { verdict: string; notes?: string } | null;
    testReport: { pass: boolean; summary?: string } | null;
    feedback: string | null;
    diagnoses: string[];
  };
  providerName: (id: string) => string;
}) {
  const t = useT();
  const latest = (role: string) =>
    runs.find((r) => r.role === role && r.status === 'succeeded');
  const coder = latest('coder');
  const reviewer = latest('reviewer');
  const tester = latest('tester');
  const debuggerRun = latest('debugger');

  const blocks: { title: string; model: string; body: string; tone?: 'ok' | 'bad' }[] = [];
  if (coder?.resultText) {
    blocks.push({ title: t('role.coder'), model: providerName(coder.providerProfileId), body: coder.resultText });
  }
  if (artifacts?.review && reviewer) {
    blocks.push({
      title: t('role.reviewer'),
      model: providerName(reviewer.providerProfileId),
      body: `**${artifacts.review.verdict}**${artifacts.review.notes ? ` — ${artifacts.review.notes}` : ''}`,
      tone: artifacts.review.verdict === 'approve' ? 'ok' : 'bad',
    });
  }
  if (artifacts?.testReport && tester) {
    blocks.push({
      title: t('role.tester'),
      model: providerName(tester.providerProfileId),
      body: `**${artifacts.testReport.pass ? t('task.testPass') : t('task.testFail')}**${artifacts.testReport.summary ? ` — ${artifacts.testReport.summary}` : ''}`,
      tone: artifacts.testReport.pass ? 'ok' : 'bad',
    });
  }
  if (artifacts?.diagnoses.length && debuggerRun) {
    blocks.push({
      title: t('role.debugger'),
      model: providerName(debuggerRun.providerProfileId),
      body: artifacts.diagnoses[artifacts.diagnoses.length - 1]!,
    });
  }
  if (blocks.length === 0) return null;

  return (
    <section className="card p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink-300">{t('task.summary')}</h2>
      <div className="space-y-3">
        {blocks.map((b, i) => (
          <div key={i} className="rounded-lg bg-ink-850 p-3">
            <p className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`font-semibold ${
                  b.tone === 'ok' ? 'text-teal-300' : b.tone === 'bad' ? 'text-red-300' : 'text-ink-200'
                }`}
              >
                {b.title}
              </span>
              <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-400">
                {b.model}
              </span>
            </p>
            <Markdown>{b.body.slice(0, 3000)}</Markdown>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The project's idea shown compactly, clamped to two lines with a toggle. */
function IdeaBox({ idea }: { idea: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const text = idea.trim();
  if (!text) return null;
  const longish = text.length > 110 || text.includes('\n');

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900/60 px-3 py-2">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-500">
        {t('project.idea')}
      </div>
      <p
        className={`whitespace-pre-wrap text-xs leading-relaxed text-ink-300 ${
          longish && !open ? 'line-clamp-2' : ''
        }`}
      >
        {text}
      </p>
      {longish && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-1 text-[11px] font-medium text-accent-300 hover:underline"
        >
          {open ? t('task.showLess') : t('task.showMore')}
        </button>
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
