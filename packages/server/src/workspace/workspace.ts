import fs from 'node:fs';
import path from 'node:path';

export interface WorkspacePaths {
  root: string;
  inputs: string;
  plan: string;
  qa: string;
  logs: string;
  artifacts: string;
}

export function workspacePaths(workspacesDir: string, projectId: string): WorkspacePaths {
  const root = path.join(workspacesDir, projectId);
  return {
    root,
    inputs: path.join(root, 'inputs'),
    plan: path.join(root, 'plan'),
    qa: path.join(root, 'qa'),
    logs: path.join(root, 'logs'),
    artifacts: path.join(root, 'artifacts'),
  };
}

export function scaffoldWorkspace(workspacesDir: string, projectId: string): WorkspacePaths {
  const paths = workspacePaths(workspacesDir, projectId);
  for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
  return paths;
}

export function slugify(text: string, maxLen = 40): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLen)
      .replace(/-+$/, '') || 'project'
  );
}
