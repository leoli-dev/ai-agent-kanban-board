import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { KANBAN_COLUMNS, type Project, type Task, type TaskStatus } from '@akb/shared';
import { api } from '../lib/api';
import { useWsTopics } from '../lib/ws';
import { KanbanColumn } from '../components/KanbanColumn';

export default function Board() {
  const { projectId } = useParams();
  const queryClient = useQueryClient();
  const [liveTaskIds, setLiveTaskIds] = useState<Set<string>>(new Set());

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<Project[]>('/api/projects'),
  });

  const tasksKey = projectId ? ['tasks', projectId] : ['tasks', 'all'];
  const { data: tasks = [] } = useQuery({
    queryKey: tasksKey,
    queryFn: () =>
      api.get<Task[]>(projectId ? `/api/projects/${projectId}/tasks` : '/api/tasks'),
  });

  const boardTopics = useMemo(() => {
    const ids = projectId ? [projectId] : projects.map((p) => p.id);
    return ['global', ...ids.map((id) => `board:${id}`)];
  }, [projectId, projects]);

  useWsTopics(boardTopics, (msg) => {
    if (msg.type === 'task.updated') {
      queryClient.setQueryData<Task[]>(tasksKey, (old) =>
        old ? old.map((t) => (t.id === msg.task.id ? msg.task : t)) : old,
      );
    } else if (msg.type === 'tasks.created') {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    } else if (msg.type === 'run.started' && msg.run.taskId) {
      setLiveTaskIds((s) => new Set(s).add(msg.run.taskId!));
    } else if (msg.type === 'run.updated' && msg.run.taskId && msg.run.status !== 'running') {
      setLiveTaskIds((s) => {
        const next = new Set(s);
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
        old ? old.map((t) => (t.id === taskId ? { ...t, status } : t)) : old,
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
    const task = tasks.find((t) => t.id === taskId);
    if (task && task.status !== target) move.mutate({ taskId, status: target });
  }

  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const visibleTasks = tasks.filter((t) => t.status !== 'failed' && t.status !== 'blocked');
  const troubled = tasks.filter((t) => t.status === 'failed' || t.status === 'blocked');
  const currentProject = projectId ? projects.find((p) => p.id === projectId) : null;

  return (
    <div className="flex h-full flex-col p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-base font-semibold">
          {currentProject ? `${currentProject.name} — Board` : 'Board'}
        </h1>
        {troubled.length > 0 && (
          <span className="rounded-full bg-rose-900/60 px-2.5 py-1 text-xs text-rose-300">
            {troubled.length} failed/blocked
          </span>
        )}
      </div>

      {tasks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-slate-500">
            No tasks yet — approve a plan to populate the board.
          </p>
        </div>
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto pb-2 sm:snap-none">
            {KANBAN_COLUMNS.map((col) => (
              <KanbanColumn
                key={col.status}
                status={col.status}
                label={col.label}
                tasks={visibleTasks.filter((t) => t.status === col.status)}
                projectNames={projectNames}
                liveTaskIds={liveTaskIds}
              />
            ))}
          </div>
          {troubled.length > 0 && (
            <div className="mt-2 flex gap-2 overflow-x-auto">
              {troubled.map((t) => (
                <a
                  key={t.id}
                  href={`/tasks/${t.id}`}
                  className="shrink-0 rounded-lg border border-rose-900 bg-rose-950/40 px-3 py-1.5 text-xs text-rose-300"
                >
                  ⚠ {t.title}
                </a>
              ))}
            </div>
          )}
        </DndContext>
      )}
    </div>
  );
}
