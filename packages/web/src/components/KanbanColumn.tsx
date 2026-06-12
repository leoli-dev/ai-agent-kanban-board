import { useDroppable } from '@dnd-kit/core';
import type { Task, TaskStatus } from '@akb/shared';
import { TaskCard } from './TaskCard';

const columnAccent: Record<string, string> = {
  backlog: 'border-t-slate-500',
  wip: 'border-t-sky-500',
  to_review: 'border-t-violet-500',
  to_test: 'border-t-amber-500',
  done: 'border-t-emerald-500',
};

export function KanbanColumn({
  status,
  label,
  tasks,
  projectNames,
  liveTaskIds,
}: {
  status: TaskStatus;
  label: string;
  tasks: Task[];
  projectNames: Map<string, string>;
  liveTaskIds: Set<string>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div
      ref={setNodeRef}
      className={`flex h-full w-[85vw] shrink-0 snap-center flex-col rounded-xl border border-slate-800 border-t-2 bg-slate-900/60 sm:w-auto sm:min-w-0 sm:flex-1 ${columnAccent[status] ?? ''} ${
        isOver ? 'bg-slate-800/80 ring-1 ring-sky-500/50' : ''
      }`}
    >
      <div className="flex items-center justify-between px-3 py-2.5">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</h3>
        <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
          {tasks.length}
        </span>
      </div>
      <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2 pt-0">
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            projectName={projectNames.get(t.projectId)}
            live={liveTaskIds.has(t.id)}
          />
        ))}
      </div>
    </div>
  );
}
