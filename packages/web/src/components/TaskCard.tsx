import { useDraggable } from '@dnd-kit/core';
import { Link } from 'react-router-dom';
import type { Task } from '@akb/shared';
import { useT } from '../lib/i18n';

export function TaskCard({
  task,
  projectName,
  live,
}: {
  task: Task;
  projectName?: string;
  live?: boolean;
}) {
  const t = useT();
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
      className={`touch-none rounded-xl border border-ink-800 bg-ink-850 p-3 transition-shadow duration-150 ${
        isDragging
          ? 'z-30 opacity-90 shadow-xl shadow-black/50 ring-2 ring-accent-400'
          : 'hover:border-ink-700'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          to={`/tasks/${task.id}`}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="min-w-0 text-sm font-medium leading-snug text-ink-100 transition-colors hover:text-accent-300"
        >
          {task.title}
        </Link>
        {live && (
          <span className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-teal-400" />
        )}
      </div>
      {(projectName || task.retryCount > 0 || task.bounceCount > 0 || task.blockedReason) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {projectName && (
            <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400">
              {projectName}
            </span>
          )}
          {task.retryCount > 0 && (
            <span className="rounded bg-accent-500/15 px-1.5 py-0.5 font-mono text-[10px] text-accent-300 tabular">
              ↻{task.retryCount}
            </span>
          )}
          {task.bounceCount > 0 && (
            <span className="rounded bg-purple-500/15 px-1.5 py-0.5 font-mono text-[10px] text-purple-300 tabular">
              ⤺{task.bounceCount}
            </span>
          )}
          {task.status === 'blocked' && task.blockedReason && (
            <span
              className="truncate rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] text-orange-300"
              title={task.blockedReason}
            >
              {t('task.blocked')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
