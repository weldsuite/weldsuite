---
name: list-tasks
description: List open WeldFlow tasks from WeldSuite MCP, prioritized for agent work. Use when the user asks for a backlog, open bugs, or /list-tasks.
disable-model-invocation: true
---

# List WeldFlow tasks

Produce a prioritized backlog from WeldSuite.

## Steps

1. `search_projects` to list projects (or use a project filter from `$ARGUMENTS`).
2. `search_tasks` for open / in-progress work. Prefer `type=bug` when the user asked for bugs; otherwise include actionable open tasks.
3. Collate into a table:

   `| ID | Title | Project | Priority | Status | Type |`

4. Recommend the top 3–5 candidates to fix next (priority × clarity × impact).
5. Do **not** claim or dispatch unless the user picks one — suggest `/fix-task <id>` next.
