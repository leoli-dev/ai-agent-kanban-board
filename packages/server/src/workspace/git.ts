import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';

export function isGitRepo(repoPath: string): boolean {
  return fs.existsSync(path.join(repoPath, '.git'));
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
