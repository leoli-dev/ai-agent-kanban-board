import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { KANBAN_COLUMNS, type Project, type ProviderProfile, type Task, type TaskStatus } from '@akb/shared';
import { api } from '../lib/api';
import { useWsTopics } from '../lib/ws';
import { useT } from '../lib/i18n';
import { Loading, LoadError } from '../components/QueryState';
import { KanbanColumn } from '../components/KanbanColumn';
import { IconBoard, IconPlus } from '../components/icons';

export default function Board() {
  const t = useT();
  const { projectId } = useParams();
  const queryClient = useQueryClient();
  // taskId -> model label of the agent currently running on it
  const [liveRuns, setLiveRuns] = useState<Map<string, string>>(new Map());

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<Project[]>('/api/projects'),
  });
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<ProviderProfile[]>('/api/providers'),
  });
  const providerLabel = useMemo(() => {
    const byId = new Map(providers.map((p) => [p.id, p]));
    return (id: string) => {
      const p = byId.get(id);
      return p ? `${p.name}${p.modelLabel ? ` · ${p.modelLabel}` : ''}` : '';
    };
  }, [providers]);

  // Seed live indicators on page load (WS events only cover changes after).
  useQuery({
    queryKey: ['activity-live-seed'],
    enabled: providers.length > 0,
    staleTime: Infinity,
    queryFn: async () => {
      const data = await api.get<{
        runs: { taskId: string | null; status: string; providerProfileId: string }[];
      }>('/api/activity?limit=50');
      setLiveRuns((prev) => {
        const next = new Map(prev);
        for (const r of data.runs) {
          if (r.status === 'running' && r.taskId) {
            next.set(r.taskId, providerLabel(r.providerProfileId));
          }
        }
        return next;
      });
      return data;
    },
  });

  const tasksKey = projectId ? ['tasks', projectId] : ['tasks', 'all'];
  const { data: tasks = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: tasksKey,
    queryFn: () => api.get<Task[]>(projectId ? `/api/projects/${projectId}/tasks` : '/api/tasks'),
  });

  const boardTopics = useMemo(() => {
    const ids = projectId ? [projectId] : projects.map((p) => p.id);
    return ['global', ...ids.map((id) => `board:${id}`)];
  }, [projectId, projects]);

  useWsTopics(boardTopics, (msg) => {
    if (msg.type === 'task.updated') {
      queryClient.setQueryData<Task[]>(tasksKey, (old) =>
        old ? old.map((x) => (x.id === msg.task.id ? msg.task : x)) : old,
      );
    } else if (msg.type === 'tasks.created') {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    } else if (msg.type === 'task.deleted') {
      queryClient.setQueryData<Task[]>(tasksKey, (old) =>
        old ? old.filter((x) => x.id !== msg.taskId) : old,
      );
    } else if (msg.type === 'run.started' && msg.run.taskId) {
      const taskId = msg.run.taskId;
      setLiveRuns((s) => new Map(s).set(taskId, providerLabel(msg.run.providerProfileId)));
    } else if (msg.type === 'run.updated' && msg.run.taskId && msg.run.status !== 'running') {
      setLiveRuns((s) => {
        const next = new Map(s);
        next.delete(msg.run.taskId!);
        return next;
      });
    }
  });

  const move = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: TaskStatus }) =>
      api.patch<Task>(`/api/tasks/${taskId}`, { status }),
    onMutate: async ({ taskId, status }) => {
      await queryClient.cancelQueries({ queryKey: tasksKey });
      queryClient.setQueryData<Task[]>(tasksKey, (old) =>
        old ? old.map((x) => (x.id === taskId ? { ...x, status } : x)) : old,
      );
    },
    onError: () => queryClient.invalidateQueries({ queryKey: tasksKey }),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
  );

  function onDragEnd(ev: DragEndEvent) {
    const taskId = String(ev.active.id);
    const target = ev.over?.id as TaskStatus | undefined;
    if (!target) return;
    const task = tasks.find((x) => x.id === taskId);
    if (task && task.status !== target) move.mutate({ taskId, status: target });
  }

  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const visibleTasks = tasks.filter((x) => x.status !== 'failed' && x.status !== 'blocked');
  const troubled = tasks.filter((x) => x.status === 'failed' || x.status === 'blocked');
  const currentProject = projectId ? projects.find((p) => p.id === projectId) : null;

  if (isLoading) return <Loading />;
  if (isError) return <LoadError error={error} onRetry={refetch} />;

  return (
    <div className="flex h-full flex-col p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-base font-semibold tracking-tight">
          {currentProject ? `${currentProject.name}` : t('board.title')}
        </h1>
        {troubled.length > 0 && (
          <span className="rounded-md bg-red-500/15 px-2.5 py-1 font-mono text-xs text-red-300 tabular">
            {t('board.failedBlocked', { n: troubled.length })}
          </span>
        )}
      </div>

      {tasks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="card rise-in max-w-sm border-dashed p-10 text-center">
            <IconBoard className="mx-auto mb-3 text-ink-500" width={30} height={30} />
            <p className="font-medium text-ink-200">{t('board.empty.title')}</p>
            <p className="mt-1 text-sm text-ink-400">{t('board.empty.body')}</p>
            <Link to="/projects/new" className="btn btn-primary mx-auto mt-5 px-4 py-2 text-sm">
              <IconPlus width={15} height={15} /> {t('board.empty.cta')}
            </Link>
          </div>
        </div>
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto pb-2 sm:snap-none">
            {KANBAN_COLUMNS.map((col) => (
              <KanbanColumn
                key={col.status}
                status={col.status}
                label={t(`task.${col.status}`)}
                tasks={visibleTasks.filter((x) => x.status === col.status)}
                projectNames={projectNames}
                liveRuns={liveRuns}
              />
            ))}
          </div>
          {troubled.length > 0 && (
            <div className="mt-2 flex gap-2 overflow-x-auto">
              {troubled.map((x) => (
                <Link
                  key={x.id}
                  to={`/tasks/${x.id}`}
                  className="shrink-0 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-950/70"
                >
                  ⚠ {x.title}
                </Link>
              ))}
            </div>
          )}
        </DndContext>
      )}
    </div>
  );
}
