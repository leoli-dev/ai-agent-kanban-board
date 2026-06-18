# AI Agent Kanban Board

**English** | [中文](README_CN.md)

Self-hosted multi-agent coding workflow for turning a product idea into an executed local code project. Create a project from a prompt, links, and uploaded files; let a planner agent ask follow-up questions and produce a plan; approve it; then track coder, reviewer, tester, and debugger agents across a kanban board.

The app is built for a single developer running agents on their own machine. It keeps model credentials local, streams every run into the UI, and can fail over across multiple AI providers when a model hits quota or authentication trouble.

## What it does

```text
idea + files + links
  -> planner agent Q&A
  -> plan.md / plan.json
  -> human approval
  -> kanban task DAG
  -> coder / reviewer / tester / debugger agents
  -> final completion report
```

- Projects dashboard with status, progress, cost-to-date, and follow-up actions.
- Planner chat for clarifying questions, plan review, requested changes, and approval.
- Per-project kanban board with Backlog, In progress, To review, To test, Done, Failed, and Blocked states.
- Task pages with acceptance criteria, live logs, run history, retry/kill/pause controls, per-task model override, and stage summaries.
- Split an oversized or stuck task back through the planner into smaller subtasks (created paused for review) and rewired into the task DAG in place.
- A per-task wall-clock deadline (default 30 minutes): a task that runs longer is stopped and counts as a failed attempt, so a too-big task fails fast instead of looping.
- Multi-provider model routing per role: planner, task creator, coder, reviewer, tester, debugger, and orchestrator test role.
- Provider presets for Claude, Codex, DeepSeek, Kimi, Qwen, GLM, MiniMax, OpenRouter, local Anthropic-compatible servers, and custom env-based profiles.
- Automatic quota cooldown and fallback to the next configured model; auth failures disable the provider and raise a notification.
- Parallel task execution through isolated git worktrees and task branches, merged back into the project integration branch when tasks finish.
- Activity ledger with run duration, status, model, token, and cost information where available.
- Notifications in-app, via macOS banners, and optionally through SMTP email.

## Requirements

- Node.js 20 or newer
- pnpm
- Git
- One or more supported agent CLIs or API keys:
  - Claude Code CLI (`claude`) for `claude-code` engine profiles
  - OpenAI Codex CLI (`codex`) for `codex` engine profiles
  - Anthropic-compatible API endpoint for DeepSeek, Kimi, Qwen, GLM, MiniMax, OpenRouter, local servers, or custom profiles
- macOS is optional, only needed for native banner notifications.

## Run locally

```bash
pnpm install
pnpm dev
```

Development mode starts:

- API server: `http://localhost:5713`
- Vite web app: `http://localhost:5173`

For a production-style local run:

```bash
pnpm build
pnpm start
```

`pnpm start` serves the built web app and API from `http://<your-ip>:5713`, which is useful from another device on the same network.

## Configuration

Open Settings in the web UI after starting the app.

1. Add model profiles under Models. Use the guided presets when possible, or create a custom profile with raw environment variables.
2. Store API keys under Secrets. They are written to `data/secrets.json` with local file permissions and are not stored in the database.
3. Assign ordered model priorities per role. Each role tries models top to bottom.
4. Tune pipeline settings: stuck threshold, wall-clock limit (the per-task deadline, default 30 min), retry count, review bounce limit, parallel task count, planner Q&A rounds, auto review, and auto test.
5. Enable notifications if you want macOS banners or SMTP email.

Secrets can be referenced in provider env vars with `${SECRET:NAME}`. If a secret is not found in `data/secrets.json`, the server falls back to the process environment.

Useful environment variables:

```bash
AKB_PORT=5713          # API / production web port
AKB_HOST=0.0.0.0       # bind address
AKB_DATA_DIR=./data    # database, secrets, uploads, workspaces, logs
```

## Project workflow

1. Create a project with an idea, a target local repo path, optional reference links, and optional uploaded files.
2. Start planning. The planner may ask questions before producing `plan.md` and structured tasks.
3. Review the plan. Approve it to start, or send requested changes back to the planner.
4. Agents work from a dedicated project branch named like `agent/<project>-<id>`.
5. Independent tasks run in isolated worktrees on task branches. Completed tasks are merged into the project branch automatically.
6. Review and test stages can run automatically, or you can turn them off and move cards manually.
7. If a task is too large or keeps failing, open it and use "Split into subtasks" to send it back to the planner; it is replaced in place by smaller subtasks (created paused for your review).
8. When every task is done, the app generates a completion report with deliverable location, how to run it, and per-task accounting.

Your normal checkout is kept separate from the task worktrees. The orchestrator refuses to start work on a dirty target repo so it does not overwrite local changes.

## Data and logs

Runtime data lives under `data/` by default:

- `data/app.db` - SQLite database
- `data/secrets.json` - local secret vault
- `data/workspaces/<project>/inputs/` - uploaded project resources
- `data/workspaces/<project>/plan/` - generated plan files
- `data/workspaces/<project>/logs/` - raw agent run logs
- `data/workspaces/<project>/artifacts/` - project artifacts and reports
- `data/workspaces/<project>/worktrees/` - integration and task worktrees

The `data/` directory is ignored by git.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```

The server test suite uses the `mock` engine so pipeline behavior can be tested without spending model tokens.

## Safety notes

- Headless coding agents run with broad local permissions appropriate for a single-user development tool.
- Use this on repos you control and keep important work committed before starting a project.
- Providers can spend real API credits. Set conservative retry, wall-clock, and concurrency limits while testing.
- This app stores secrets locally, not in the hosted GitHub repo.

## License

[MIT](LICENSE)
