import type { ProjectStatus, TaskStatus } from '@akb/shared';

/* One accent (amber) for action; statuses use muted semantic tints. */
export const projectStatusStyle: Record<ProjectStatus, string> = {
  draft: 'bg-ink-800 text-ink-300',
  planning: 'bg-accent-500/15 text-accent-300',
  awaiting_answers: 'bg-accent-500/25 text-accent-300',
  awaiting_approval: 'bg-accent-400/20 text-accent-300 ring-1 ring-accent-500/40',
  running: 'bg-teal-500/15 text-teal-300',
  paused: 'bg-ink-800 text-ink-400',
  done: 'bg-teal-500/20 text-teal-300',
  failed: 'bg-red-500/15 text-red-300',
};

export const taskStatusStyle: Record<TaskStatus, string> = {
  backlog: 'bg-ink-800 text-ink-300',
  wip: 'bg-accent-500/15 text-accent-300',
  to_review: 'bg-purple-500/15 text-purple-300',
  to_test: 'bg-sky-500/15 text-sky-300',
  done: 'bg-teal-500/20 text-teal-300',
  failed: 'bg-red-500/15 text-red-300',
  blocked: 'bg-orange-500/15 text-orange-300',
};

/** Kanban column top accents — data semantics, kept muted. */
export const columnAccent: Record<string, string> = {
  backlog: 'bg-ink-500',
  wip: 'bg-accent-400',
  to_review: 'bg-purple-400/80',
  to_test: 'bg-sky-400/80',
  done: 'bg-teal-400/80',
};

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Absolute clock time: "HH:MM" when today, otherwise "MMM D HH:MM". */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/** The task's step number in the plan flow — from its plan step id, else its
 * topological order. Returns just the number as a string. */
export function stepNumber(task: { planStepId: string | null; orderIndex: number }): string {
  return task.planStepId?.match(/(\d+)/)?.[1] ?? String(task.orderIndex + 1);
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return '—';
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}
