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

/** Commit everything in the working tree (used as a safety net after agent runs). */
export async function commitAll(repoPath: string, message: string): Promise<boolean> {
  const git = simpleGit(repoPath);
  const status = await git.status();
  if (status.isClean()) return false;
  await git.add('-A');
  await git.commit(message);
  return true;
}
