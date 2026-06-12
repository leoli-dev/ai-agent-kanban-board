import { useDroppable } from '@dnd-kit/core';
import type { Task, TaskStatus } from '@akb/shared';
import { columnAccent } from '../lib/format';
import { TaskCard } from './TaskCard';

export function KanbanColumn({
  status,
  label,
  tasks,
  projectNames,
  liveRuns,
}: {
  status: TaskStatus;
  label: string;
  tasks: Task[];
  projectNames: Map<string, string>;
  liveRuns: Map<string, string>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div
      ref={setNodeRef}
      className={`flex h-full w-[82vw] shrink-0 snap-center flex-col rounded-2xl border bg-ink-900/70 transition-colors duration-150 sm:w-auto sm:min-w-0 sm:flex-1 ${
        isOver ? 'border-accent-500/50 bg-ink-850' : 'border-ink-800'
      }`}
    >
      <div className="flex items-center gap-2 px-3.5 py-3">
        <span className={`h-2 w-2 rounded-full ${columnAccent[status] ?? 'bg-ink-500'}`} />
        <h3 className="text-[13px] font-semibold text-ink-200">{label}</h3>
        <span className="ml-auto rounded-md bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-ink-400 tabular">
          {tasks.length}
        </span>
      </div>
      <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2 pt-0">
        {tasks.map((task, i) => (
          <div key={task.id} className="rise-in" style={{ animationDelay: `${i * 30}ms` }}>
            <TaskCard
              task={task}
              projectName={projectNames.get(task.projectId)}
              liveModel={liveRuns.has(task.id) ? (liveRuns.get(task.id) ?? '') : undefined}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
