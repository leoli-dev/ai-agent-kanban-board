# Agent Kanban Board

Self-hosted multi-agent AI coding workflow platform. Turn one idea (prompt + files/images/PDFs/links) into an executed coding project: a planner agent refines it and asks clarifying questions, you approve the plan, and an orchestrator drives coder/reviewer/tester sub-agents across a kanban board — with **multi-provider AI fallback** at its core.

## How it works

```
idea + resources ──> planner agent (Q&A loop) ──> plan.md / plan.json ──> YOU approve
                                                                            │
   Backlog ─ WIP ─ To Review ─ To Test ─ Done   <── kanban tasks (topo-sorted DAG)
      │
 orchestrator loop: picks ready tasks ──> coder agent (commits to agent/<project> branch)
      ├─ reviewer agent: approve / changes_requested (bounce back, bounded)
      ├─ tester agent: runs the tests, pass / fail (bounce back, bounded)
      ├─ stuck watchdog ──> debugger agent diagnoses ──> kill ──> retry with diagnosis
      └─ all done ──> notification (in-app + macOS banner + email)
```

**Providers**: every agent role (planner, coder, reviewer, tester, debugger, …) has an ordered provider list. A provider = an engine (`claude-code`, `codex`) + env vars (e.g. `ANTHROPIC_BASE_URL` pointing at DeepSeek/MiniMax/ollama/omlx Anthropic-compatible endpoints). Out of quota → automatic cooldown + fallback to the next provider. Auth failure → disabled + notification.

## Requirements

- Node ≥ 20, pnpm (`npm i -g pnpm`)
- Claude Code CLI (`claude`) and/or Codex CLI (`codex`) installed
- macOS for banner notifications (optional)

## Run

```bash
pnpm install
pnpm dev        # dev: server :5713 + web :5173 (proxied)
# or production-ish:
pnpm build && pnpm start   # everything on http://<your-ip>:5713 (phone-friendly)
```

## Setup (in the web UI → Settings)

1. **Providers** — add profiles, e.g.:
   - `anthropic`: engine `claude-code`, env `ANTHROPIC_API_KEY=${SECRET:ANTHROPIC_API_KEY}`
   - `deepseek`: engine `claude-code`, env `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_AUTH_TOKEN=${SECRET:DEEPSEEK_API_KEY}`, `ANTHROPIC_MODEL=deepseek-v4-pro[1m]`, …
   - `omlx-local`: engine `claude-code`, env `ANTHROPIC_BASE_URL=http://127.0.0.1:8000`, …
   - `codex`: engine `codex`, model label e.g. `gpt-5.3-codex`
2. **Secrets** — store API keys (kept in `data/secrets.json`, chmod 600, never in the DB; falls back to your shell env).
3. **Roles** — order providers per role, e.g. coder: `codex → deepseek → omlx-local`. Use the **Test** button on each provider.
4. Create a project: prompt + target local git repo + optional files/links → **Start planning**.

Agents work on a dedicated `agent/<project>` branch of your repo; you merge when satisfied. Auto review/test stages can be toggled off to handle those columns manually (drag cards on the board — manual moves always win).

## Notes

- All runs are logged as raw NDJSON under `data/workspaces/<project>/logs/`; live streaming in the task view.
- The `mock` engine replays scripted streams — used by the test suite (`pnpm test`, 21 integration tests) so the whole pipeline is testable without spending tokens.
- Headless agents run with permissions skipped (`--dangerously-skip-permissions` / codex sandbox) — single-user tool, dedicated branch, local machine. Don't point it at repos with uncommitted work (the orchestrator refuses to start tasks on a dirty tree).

## License

[MIT](LICENSE)
