import { Link, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentRun, PlanDocument, Project, ProjectInput, Task } from '@akb/shared';
import { api } from '../lib/api';
import { Markdown } from '../components/Markdown';
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
  const { data: report } = useQuery({
    queryKey: ['report', projectId],
    queryFn: () => api.get<{ md: string | null }>(`/api/projects/${projectId}/report`),
    enabled: !!project && project.status === 'done',
    // The how-to-run section is agent-written; poll until the placeholder is gone.
    refetchInterval: (q) => (q.state.data?.md?.includes('⏳') ? 15_000 : false),
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
  const pause = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/pause`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
  });
  const resume = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/resume`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
  });
  const removeProject = useMutation({
    mutationFn: () => api.delete(`/api/projects/${projectId}`),
    onSuccess: () => navigate('/projects'),
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
        {project.status === 'running' && (
          <button
            onClick={() => pause.mutate()}
            disabled={pause.isPending}
            className="btn btn-ghost px-4 py-2 text-sm"
          >
            ⏸ {t('project.pause')}
          </button>
        )}
        {project.status === 'paused' && (
          <button
            onClick={() => resume.mutate()}
            disabled={resume.isPending}
            className="btn btn-primary px-4 py-2 text-sm"
          >
            ▶ {t('project.resume')}
          </button>
        )}
        <button
          onClick={() => {
            if (confirm(t('project.deleteConfirm', { name: project.name }))) removeProject.mutate();
          }}
          disabled={removeProject.isPending}
          className="btn btn-danger ml-auto px-4 py-2 text-sm"
        >
          {t('common.delete')}
        </button>
      </div>


      <section className="card p-4">
        <h2 className="mb-2 text-sm font-semibold text-ink-300">{t('project.idea')}</h2>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-200">{project.prompt}</p>
        <ProjectInputs inputs={project.inputs} t={t} />
      </section>

      {startPlanning.isError && (
        <p className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-300">
          {String((startPlanning.error as Error).message)}
        </p>
      )}

      {planMd?.md && (
        <CollapsibleCard
          title={t('project.plan')}
          defaultOpen={project.status === 'awaiting_approval'}
          action={
            project.status === 'awaiting_approval' && (
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
            )
          }
        >
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
          <Markdown>{planMd.md}</Markdown>
        </CollapsibleCard>
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

      {project.status === 'done' && report?.md && (
        <CollapsibleCard
          title={<>🎉 {t('project.report')}</>}
          defaultOpen
          className="rise-in border-teal-500/30"
          titleClassName="text-teal-300"
        >
          <Markdown>{report.md}</Markdown>
        </CollapsibleCard>
      )}
    </div>
  );
}

/** Card with a collapsible body toggled by clicking its header. */
function CollapsibleCard({
  title,
  children,
  action,
  defaultOpen = true,
  className = '',
  titleClassName = 'text-ink-300',
}: {
  title: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  titleClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`card p-4 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-left"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 text-ink-500 transition-transform ${open ? 'rotate-90' : ''}`}
          >
            <path d="M4 2l4 4-4 4" />
          </svg>
          <h2 className={`text-sm font-semibold ${titleClassName}`}>{title}</h2>
        </button>
        {action}
      </div>
      {open && <div className="mt-3">{children}</div>}
    </section>
  );
}

/** Reference links and uploaded resource files captured at project creation. */
function ProjectInputs({
  inputs,
  t,
}: {
  inputs: ProjectInput[];
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setLightbox(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);
  if (inputs.length === 0) return null;
  const links = inputs.filter((i) => i.kind === 'link');
  const files = inputs.filter((i) => i.kind !== 'link');

  return (
    <div className="mt-4 space-y-3 border-t border-ink-800 pt-3">
      {links.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-medium text-ink-400">{t('new.links')}</h3>
          <ul className="space-y-1">
            {links.map((i) => (
              <li key={i.id}>
                <a
                  href={i.pathOrUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-xs text-amber-400 hover:underline"
                >
                  {i.pathOrUrl}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {files.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-medium text-ink-400">{t('new.files')}</h3>
          <div className="flex flex-wrap gap-2">
            {files.map((i) => {
              const name = i.originalName ?? i.pathOrUrl.split('/').pop() ?? 'file';
              const href = `/api/inputs/${i.id}/file`;
              return i.kind === 'image' ? (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => setLightbox({ src: href, name })}
                  title={name}
                  className="rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400"
                >
                  <img
                    src={href}
                    alt={name}
                    className="h-20 w-20 cursor-zoom-in rounded-md border border-ink-800 object-cover transition-opacity hover:opacity-80"
                  />
                </button>
              ) : (
                <a
                  key={i.id}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md bg-ink-800 px-2 py-1 text-xs text-ink-300 hover:bg-ink-700"
                >
                  {name}
                </a>
              );
            })}
          </div>
        </div>
      )}
      {lightbox && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.name}
          onClick={() => setLightbox(null)}
          className="rise-in fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <img
            src={lightbox.src}
            alt={lightbox.name}
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            style={{ imageRendering: 'pixelated' }}
          />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label="Close"
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-ink-800/80 text-lg text-ink-200 hover:bg-ink-700"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
