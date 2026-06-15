import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';

export function isGitRepo(repoPath: string): boolean {
  return fs.existsSync(path.join(repoPath, '.git'));
}

/**
 * Initialize a git repo with a baseline commit so HEAD exists (agent branch
 * creation and dirty-tree checks need one). Existing files become the
 * baseline; an empty dir gets a README stub.
 */
export async function initRepoWithBaseline(repoPath: string, title: string): Promise<void> {
  const git = simpleGit(repoPath);
  if (!isGitRepo(repoPath)) {
    await git.raw(['init', '-b', 'main']).catch(() => git.init());
  }
  const hasHead = await git
    .raw(['rev-parse', '--verify', 'HEAD'])
    .then(() => true)
    .catch(() => false);
  if (hasHead) return;

  const hasFiles = fs.readdirSync(repoPath).some((f) => f !== '.git');
  if (!hasFiles) {
    fs.writeFileSync(path.join(repoPath, 'README.md'), `# ${title}\n`);
  }
  await git.add('-A');
  try {
    await git.commit('init: baseline');
  } catch {
    // No git identity configured: set a local one so the commit succeeds.
    await git.addConfig('user.name', 'agent-kanban');
    await git.addConfig('user.email', 'agent-kanban@localhost');
    await git.commit('init: baseline');
  }
}

/** Create (if needed) and check out the project's agent branch from current HEAD. */
export async function ensureBranch(repoPath: string, branch: string): Promise<void> {
  const git = simpleGit(repoPath);
  const branches = await git.branchLocal();
  if (branches.all.includes(branch)) {
    await git.checkout(branch);
  } else {
    await git.checkoutLocalBranch(branch);
  }
}

export async function isDirty(repoPath: string): Promise<boolean> {
  const status = await simpleGit(repoPath).status();
  return !status.isClean();
}

export async function currentBranch(repoPath: string): Promise<string> {
  const status = await simpleGit(repoPath).status();
  return status.current ?? '';
}

/**
 * Worktree helpers for parallel task execution: each task gets its own
 * branch + worktree; an "integration" worktree holds the project branch so
 * the user's own checkout is never touched.
 */
export async function ensureWorktree(
  repoPath: string,
  dir: string,
  branch: string,
  base: string,
): Promise<void> {
  if (fs.existsSync(path.join(dir, '.git'))) return;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const git = simpleGit(repoPath);
  await git.raw(['worktree', 'prune']).catch(() => {});
  const branches = await git.branchLocal();
  if (branches.all.includes(branch)) {
    await git.raw(['worktree', 'add', dir, branch]);
  } else {
    await git.raw(['worktree', 'add', '-b', branch, dir, base]);
  }
}

/**
 * Add a throwaway worktree checked out at `ref` in DETACHED HEAD. Because it
 * does not occupy the branch, the branch stays free for the user (or another
 * worktree) to check out while an agent reads the files here.
 */
export async function addDetachedWorktree(
  repoPath: string,
  dir: string,
  ref: string,
): Promise<void> {
  if (fs.existsSync(path.join(dir, '.git'))) return;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const git = simpleGit(repoPath);
  await git.raw(['worktree', 'prune']).catch(() => {});
  await git.raw(['worktree', 'add', '--detach', dir, ref]);
}

export async function removeWorktree(repoPath: string, dir: string): Promise<void> {
  const git = simpleGit(repoPath);
  try {
    await git.raw(['worktree', 'remove', '--force', dir]);
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    await git.raw(['worktree', 'prune']).catch(() => {});
  }
}

/**
 * A branch can only be checked out in one worktree: if the user's main
 * checkout sits on `branch` (legacy single-branch mode), move it off —
 * preferably to main/master, otherwise detach.
 */
export async function ensureNotOnBranch(repoPath: string, branch: string): Promise<void> {
  const git = simpleGit(repoPath);
  const status = await git.status();
  if (status.current !== branch) return;
  // Leftovers from an interrupted agent run under legacy single-branch mode
  // belong to the agent branch — commit them before switching away.
  if (!status.isClean()) {
    await commitAll(repoPath, 'wip: leftover agent work (migrated to worktree mode)');
  }
  const locals = await git.branchLocal();
  const fallback = ['main', 'master'].find((b) => locals.all.includes(b));
  if (fallback) {
    await git.checkout(fallback);
  } else {
    await git.raw(['checkout', '--detach']);
  }
}

export async function pruneWorktrees(repoPath: string): Promise<void> {
  await simpleGit(repoPath)
    .raw(['worktree', 'prune'])
    .catch(() => {});
}

/** The repo's default branch — main/master if present, else the current one. */
export async function defaultBranch(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);
  const locals = await git.branchLocal();
  return (
    ['main', 'master'].find((b) => locals.all.includes(b)) ??
    locals.current ??
    'main'
  );
}

/**
 * Check out `target` in the repo's own working tree and merge `source` into it.
 * Used to land a finished fresh project's agent branch on main. Returns 'ok',
 * 'conflict' (merge aborted), or 'error' (e.g. dirty tree blocked checkout).
 */
export async function mergeBranchInto(
  repoPath: string,
  target: string,
  source: string,
): Promise<'ok' | 'conflict' | 'error'> {
  const git = simpleGit(repoPath);
  try {
    await git.checkout(target);
  } catch {
    return 'error';
  }
  try {
    await git.raw(['merge', '--no-ff', '-m', `Merge ${source} into ${target}`, source]);
    return 'ok';
  } catch {
    await git.raw(['merge', '--abort']).catch(() => {});
    return 'conflict';
  }
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await simpleGit(repoPath)
    .raw(['branch', '-D', branch])
    .catch(() => {});
}

/** Merge `branch` into the branch checked out in `worktreeDir`. */
export async function mergeIntoCurrent(
  worktreeDir: string,
  branch: string,
  message: string,
): Promise<'ok' | 'conflict'> {
  const git = simpleGit(worktreeDir);
  try {
    await git.raw(['merge', '--no-ff', '-m', message, branch]);
    return 'ok';
  } catch {
    await git.raw(['merge', '--abort']).catch(() => {});
    return 'conflict';
  }
}

/**
 * Merge the base branch into a task worktree before (re)starting work.
 * On conflict the markers are left in place for the coder agent to resolve.
 */
export async function mergeBaseLeaveConflicts(
  worktreeDir: string,
  baseBranch: string,
): Promise<'ok' | 'conflict'> {
  const git = simpleGit(worktreeDir);
  try {
    await git.raw(['merge', baseBranch, '-m', `merge ${baseBranch} into task branch`]);
    return 'ok';
  } catch {
    return 'conflict';
  }
}

/**
 * Reset a worktree to its last commit, dropping every uncommitted change and
 * untracked file. Used after a reviewer/tester run (which must never commit) so
 * scratch/debug files they leave behind don't pollute the next coder's commit.
 */
export async function discardUncommitted(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.raw(['reset', '--hard', 'HEAD']).catch(() => {});
  await git.raw(['clean', '-fd']).catch(() => {});
}

/** Commit everything in the working tree (used as a safety net after agent runs). */
export async function commitAll(repoPath: string, message: string): Promise<boolean> {
  const git = simpleGit(repoPath);
  const status = await git.status();
  if (status.isClean()) return false;
  await git.add('-A');
  await git.commit(message);
  return true;
}
