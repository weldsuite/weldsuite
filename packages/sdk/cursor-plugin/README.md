# WeldSuite Cursor Plugin

Connect [Cursor](https://cursor.com) to [WeldSuite](https://weldsuite.org) so agents can read and update **WeldFlow** tasks, then implement the work in your repository.

## What you get

| Component | Purpose |
| --- | --- |
| **MCP** (`mcp.weldsuite.org`) | OAuth-backed tools: `get_task`, `search_tasks`, `update_task`, `search_projects`, … |
| **Skills** | `/fix-task`, `/list-tasks`, `/claim-task`, `/done-task`, `/enrich-task` |
| **Agents** | `weldflow-dispatcher` (classify) → `weldflow-task-fixer` (implement + close the loop) |
| **Rule** | Prefer WeldSuite MCP as the source of truth for task state |

## Install

### Marketplace (recommended)

1. Open **Cursor → Customize → Plugins** (or [cursor.com/marketplace](https://cursor.com/marketplace)).
2. Install **WeldSuite**.
3. Enable the **weldsuite** MCP server and complete Clerk OAuth when prompted (pick the workspace org that has `user:org:read`).

### Local / team testing

Symlink this folder into your local plugins directory, then reload Cursor:

```bash
mkdir -p ~/.cursor/plugins/local
ln -sfn "$(pwd)/packages/sdk/cursor-plugin" ~/.cursor/plugins/local/weldsuite
```

Or import this Git repository as a **Team Marketplace** source (Dashboard → Plugins). The root `.cursor-plugin/marketplace.json` points at `packages/sdk/cursor-plugin`.

## Quick start

After MCP is connected:

```text
/list-tasks
/fix-task tsk_xxxxxxxxxx
```

Or in Agent chat:

```text
Fix WeldFlow task tsk_xxxxxxxxxx
```

The dispatcher loads the task, the fixer claims it, implements against **your open workspace**, verifies with your project’s usual commands, and updates the task comment/status in WeldSuite.

## Skills

| Skill | Slash | What it does |
| --- | --- | --- |
| `fix-task` | `/fix-task <id>` | Full pipeline: load → dispatch → implement → update task |
| `list-tasks` | `/list-tasks` | Prioritized open backlog from WeldFlow |
| `claim-task` | `/claim-task <id>` | Assign + `in_progress` only |
| `done-task` | `/done-task <id> [pr-or-sha]` | Verify, comment, set `in_review` / `done` |
| `enrich-task` | `/enrich-task <id>` | Interview + append `## Enriched analysis` |

## Auth notes

- MCP URL: `https://mcp.weldsuite.org/mcp`
- Auth is **OAuth via Clerk** (no API token in the plugin). Dynamic client registration must be enabled on the WeldSuite Clerk instance.
- Tokens need `user:org:read` so the server can resolve your workspace.

## Layout

```text
packages/sdk/cursor-plugin/
├── .cursor-plugin/plugin.json
├── mcp.json
├── agents/
├── skills/
├── rules/
├── assets/logo.svg
└── README.md
```

Repo-root `.cursor-plugin/marketplace.json` registers this plugin for multi-plugin / team marketplace import.

## Publishing

1. Validate locally (`~/.cursor/plugins/local/weldsuite`).
2. Submit the repository at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish) (or add as a Team Marketplace).
3. Checklist: valid `plugin.json`, skill/agent frontmatter, logo path, README, OAuth MCP reachable.

## Related

- MCP worker: `apps/workers/mcp-server`
- Internal Claude Code agent workflow (monorepo-specific): `.claude/agents`, `.claude/commands`
