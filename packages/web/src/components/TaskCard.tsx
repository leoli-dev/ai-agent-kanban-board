import { useDraggable } from '@dnd-kit/core';
import { Link } from 'react-router-dom';
import type { Task } from '@akb/shared';

export function TaskCard({
  task,
  projectName,
  live,
}: {
  task: Task;
  projectName?: string;
  live?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={
        transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined
      }
      className={`touch-none rounded-lg border border-slate-700/60 bg-slate-800 p-3 shadow-sm ${
        isDragging ? 'z-30 opacity-80 ring-2 ring-sky-500' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          to={`/tasks/${task.id}`}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="min-w-0 text-sm font-medium text-slate-100 hover:text-sky-300"
        >
          {task.title}
        </Link>
        {live && <span className="mt-0.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400" />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {projectName && (
          <span className="rounded bg-slate-700/70 px-1.5 py-0.5 text-[10px] text-slate-300">
            {projectName}
          </span>
        )}
        {task.retryCount > 0 && (
          <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] text-amber-300">
            retry {task.retryCount}
          </span>
        )}
        {task.bounceCount > 0 && (
          <span className="rounded bg-violet-900/60 px-1.5 py-0.5 text-[10px] text-violet-300">
            bounce {task.bounceCount}
          </span>
        )}
        {task.status === 'blocked' && task.blockedReason && (
          <span
            className="truncate rounded bg-orange-900/60 px-1.5 py-0.5 text-[10px] text-orange-300"
            title={task.blockedReason}
          >
            {task.blockedReason}
          </span>
        )}
      </div>
    </div>
  );
}
