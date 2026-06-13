import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { AgentRun, Project } from '@akb/shared';
import { schema, type Db } from '../db/index.js';
import { listProjectTasks } from '../db/task-store.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { RunStore } from '../runner/run-store.js';
import type { AgentRunner } from '../runner/agent-runner.js';
import { workspacePaths } from '../workspace/workspace.js';
import { addDetachedWorktree, removeWorktree } from '../workspace/git.js';

const HOW_TO_RUN_PLACEHOLDER =
  '_⏳ 智能体正在阅读成品并撰写运行指南… / An agent is reading the result and writing run instructions…_';

/**
 * The final deliverable document for a finished project: where the result
 * lives, what each task produced (and which model produced it), totals, and
 * an agent-written "what was built / how to run it" section.
 */
export class ReportService {
  private enriching = new Set<string>();

  constructor(
    private deps: {
      db: Db;
      runStore: RunStore;
      registry: ProviderRegistry;
      runner: AgentRunner;
      workspacesDir: string;
    },
  ) {}

  reportPath(project: Project): string {
    return path.join(workspacePaths(this.deps.workspacesDir, project.id).root, 'REPORT.md');
  }

  /** Return the report, building the deterministic part on first request and
   * kicking off agent enrichment in the background. */
  ensure(project: Project): string {
    const file = this.reportPath(project);
    let md: string;
    if (fs.existsSync(file)) {
      md = fs.readFileSync(file, 'utf8');
    } else {
      md = this.buildDeterministic(project);
      fs.writeFileSync(file, md);
    }
    if (md.includes(HOW_TO_RUN_PLACEHOLDER) && !this.enriching.has(project.id)) {
      this.enriching.add(project.id);
      void this.enrich(project).finally(() => this.enriching.delete(project.id));
    }
    return md;
  }

  private buildDeterministic(project: Project): string {
    const tasks = listProjectTasks(this.deps.db, project.id);
    const runs = this.deps.runStore.listByProject(project.id);
    const profiles = new Map(this.deps.registry.list().map((p) => [p.id, p]));
    const label = (id: string) => {
      const p = profiles.get(id);
      return p ? `${p.name}${p.modelLabel ? ` (${p.modelLabel})` : ''}` : id.slice(0, 6);
    };

    const totalCost = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    const totalIn = runs.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
    const totalOut = runs.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
    const failures = runs.filter((r) => ['failed', 'stuck', 'killed'].includes(r.status)).length;
    const durationH = project.completedAt
      ? ((project.completedAt - project.createdAt) / 3_600_000).toFixed(1)
      : '?';

    const taskBlocks = tasks
      .map((task) => {
        const taskRuns = runs.filter((r) => r.taskId === task.id);
        const coder = taskRuns.find((r) => r.role === 'coder' && r.status === 'succeeded');
        const cost = taskRuns.reduce((s, r) => s + (r.costUsd ?? 0), 0);
        const models = [...new Set(taskRuns.map((r) => `${shortRole(r)} ${label(r.providerProfileId)}`))];
        const summary = coder?.resultText
          ? `\n${trimSummary(coder.resultText)}`
          : '';
        return `### ${statusIcon(task.status)} ${task.title}\n- 模型 models: ${models.join(' · ') || '—'}\n- 花费 cost: $${cost.toFixed(3)} · 重试 retries: ${task.retryCount} · 打回 bounces: ${task.bounceCount}${summary}`;
      })
      .join('\n\n');

    return `# 项目完成报告 · Project Report

**${project.name}**

完成于 / completed: ${project.completedAt ? new Date(project.completedAt).toLocaleString() : '—'} · 历时 / duration: ${durationH}h

## 📦 成果在哪里 / Where the result lives

- 仓库 repo: \`${project.targetRepoPath}\`
- 分支 branch: \`${project.gitBranch}\`

查看成果 / check it out:

\`\`\`bash
cd ${project.targetRepoPath}
git checkout ${project.gitBranch}
\`\`\`

满意后合并 / merge when satisfied:

\`\`\`bash
git checkout main && git merge ${project.gitBranch}
\`\`\`

## 🚀 做了什么 · 如何运行 / What was built · How to run

${HOW_TO_RUN_PLACEHOLDER}

## ✅ 任务明细 / Tasks

${taskBlocks}

## 📊 统计 / Stats

| | |
|---|---|
| 总花费 total cost | $${totalCost.toFixed(2)} |
| tokens (in/out) | ${totalIn.toLocaleString()} / ${totalOut.toLocaleString()} |
| 运行次数 agent runs | ${runs.length} (${failures} failed/killed) |
`;
  }

  /** Cheap agent reads the finished branch and writes the user-facing
   * "what & how to run" section in the user's language. */
  private async enrich(project: Project): Promise<void> {
    const role = this.deps.registry.pickForRole('task-creator')
      ? ('task-creator' as const)
      : this.deps.registry.pickForRole('reviewer')
        ? ('reviewer' as const)
        : null;
    if (!role) return;

    // Read the finished code from a DETACHED worktree at the branch tip: this
    // lets the agent inspect the result without occupying the branch, so the
    // user can still `git checkout` it (the integration worktree is gone by now).
    const ws = workspacePaths(this.deps.workspacesDir, project.id);
    const reviewDir = path.join(ws.root, 'worktrees', '_report');
    let cwd = project.targetRepoPath;
    let tempWorktree = false;
    if (project.gitBranch) {
      try {
        await addDetachedWorktree(project.targetRepoPath, reviewDir, project.gitBranch);
        cwd = reviewDir;
        tempWorktree = true;
      } catch {
        // Branch may still be checked out elsewhere (e.g. an older project whose
        // integration worktree lingers); fall back to reading it there.
        const integrationDir = path.join(ws.root, 'worktrees', '_integration');
        if (fs.existsSync(integrationDir)) cwd = integrationDir;
      }
    }

    try {
      const outcome = await this.deps.runner.run({
        role,
        prompt: `You are writing the final hand-off report section for a completed project. The finished code is on branch ${project.gitBranch}, checked out in your working directory. The user's original request was:

"${project.prompt.slice(0, 800)}"

Inspect the result (read files; you may run quick non-destructive commands) and reply with ONLY a markdown section, written in the SAME LANGUAGE as the user's request above, with exactly these parts:
1. **做了什么 / What was built** — 3-6 bullet points of what exists now.
2. **如何运行 / How to run** — exact commands or steps (e.g. open which file, run which command, visit which URL).
3. **建议验收 / What to check** — 2-4 things the user should try to confirm it works.

Maximum 40 lines. No preamble, no code changes, do not commit anything.`,
        cwd,
        logDir: ws.logs,
        projectId: project.id,
        addDirs: [ws.root],
        timeouts: { stuckMs: 5 * 60_000, wallClockMs: 10 * 60_000 },
      });
      const section = outcome.ok ? outcome.finalRun?.resultText : null;
      if (!section) return;
      const file = this.reportPath(project);
      const md = fs.readFileSync(file, 'utf8').replace(HOW_TO_RUN_PLACEHOLDER, section.trim());
      fs.writeFileSync(file, md);
    } catch {
      /* report stays with placeholder; regenerated on next request */
    } finally {
      if (tempWorktree) {
        await removeWorktree(project.targetRepoPath, reviewDir).catch(() => {});
      }
    }
  }

  /** Regenerate from scratch (e.g. tasks changed after completion). */
  invalidate(project: Project): void {
    try {
      fs.rmSync(this.reportPath(project));
    } catch {
      /* fine */
    }
  }
}

function statusIcon(status: string): string {
  return status === 'done' ? '✅' : status === 'failed' ? '❌' : '▫️';
}

function shortRole(run: AgentRun): string {
  const names: Partial<Record<AgentRun['role'], string>> = {
    coder: '编码',
    reviewer: '审查',
    tester: '测试',
    debugger: '诊断',
    planner: '规划',
  };
  return names[run.role] ?? run.role;
}

function trimSummary(text: string): string {
  const cleaned = text.trim();
  if (cleaned.length <= 600) return cleaned;
  return cleaned.slice(0, 600) + ' …';
}

export function getProjectOrNull(db: Db, id: string) {
  return db.select().from(schema.projects).where(eq(schema.projects.id, id)).get() ?? null;
}
