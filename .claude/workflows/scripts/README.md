# Dashboard regenerate script

## What it does

`regenerate-dashboard.mjs` refreshes the task data in `../dashboard.html` from live WeldSuite state.

It works by spawning `claude -p` (Claude Code's headless mode) which has the `mcp__weldsuite__*` tools available. The script asks Claude to fetch every open task assigned to you, emit it as JSON, and parses it back. Then it merges the result with the curated bundles in `./bundle-config.mjs` and patches the `<DATA>` block in `dashboard.html`.

No DB credentials, no direct API tokens, it reuses whatever auth your `claude` CLI is already using.

## Usage

```powershell
# Default: refresh for Gert (user_3984pBydzNbnt1KVhOHY5fZYzqq)
node .claude/workflows/scripts/regenerate-dashboard.mjs

# Different user
node .claude/workflows/scripts/regenerate-dashboard.mjs --user user_xxxxxxxx

# Preview without writing
node .claude/workflows/scripts/regenerate-dashboard.mjs --dry-run
```

## Editing the bundles

Open `bundle-config.mjs`. Add/remove bundles, change their order (top = next to ship), tweak the `hyp` and `specialist` fields. Tasks not listed in any bundle become singleton PRs ordered by priority.

You don't need to remove a task ID when it's closed, the script silently drops tasks the MCP no longer returns.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Failed to spawn 'claude'` | Install Claude Code CLI and make sure `claude` is on PATH. Try `claude --version` in the same shell. |
| `No <DATA>...</DATA> block in claude output` | The headless run probably asked a question or refused. Re-run; if it persists, run the prompt manually with `claude -p` to see what came back. |
| `dashboard.html is missing the /* DATA-START */ markers` | You hand-edited the dashboard and removed the markers. Restore them around the `const DATA = {…};` declaration. |
| New tasks not appearing | They're probably in the singletons list. Scroll down or filter by "Singletons". To promote them into a bundle, add their IDs to `bundle-config.mjs` and re-run. |

## When to run

- Whenever new bugs are filed and you want them in the dashboard
- Before each sprint planning session
- After a long session of `/done` calls (to drop closed tasks from the dashboard)
