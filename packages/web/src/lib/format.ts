import type { ProjectStatus, TaskStatus } from '@akb/shared';

export const projectStatusStyle: Record<ProjectStatus, string> = {
  draft: 'bg-slate-700 text-slate-200',
  planning: 'bg-indigo-600/30 text-indigo-300',
  awaiting_answers: 'bg-amber-600/30 text-amber-300',
  awaiting_approval: 'bg-violet-600/30 text-violet-300',
  running: 'bg-sky-600/30 text-sky-300',
  paused: 'bg-slate-600/40 text-slate-300',
  done: 'bg-emerald-600/30 text-emerald-300',
  failed: 'bg-rose-600/30 text-rose-300',
};

export const projectStatusLabel: Record<ProjectStatus, string> = {
  draft: 'Draft',
  planning: 'Planning…',
  awaiting_answers: 'Needs answers',
  awaiting_approval: 'Awaiting approval',
  running: 'Running',
  paused: 'Paused',
  done: 'Done',
  failed: 'Failed',
};

export const taskStatusStyle: Record<TaskStatus, string> = {
  backlog: 'bg-slate-700 text-slate-200',
  wip: 'bg-sky-600/30 text-sky-300',
  to_review: 'bg-violet-600/30 text-violet-300',
  to_test: 'bg-amber-600/30 text-amber-300',
  done: 'bg-emerald-600/30 text-emerald-300',
  failed: 'bg-rose-600/30 text-rose-300',
  blocked: 'bg-orange-600/30 text-orange-300',
};

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return '—';
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}
