---
name: fix-task
description: End-to-end fix for a WeldFlow task — load from WeldSuite MCP, claim, implement in the current repo, verify, and update task status. Use when the user says fix task, /fix-task, or pastes a tsk_ id / WeldFlow URL.
disable-model-invocation: true
---

# Fix WeldFlow task

Fix WeldFlow task `$ARGUMENTS` (task id, URL, or search text).

## Pipeline

1. **Resolve the task.** Call `get_task` if you have an id; otherwise `search_tasks` and confirm the match with the user if ambiguous.
2. **Dispatch.** Invoke the `weldflow-dispatcher` agent to classify and produce a short plan.
3. **Implement.** Invoke `weldflow-task-fixer` with that plan. It claims the task, implements, verifies, and updates WeldSuite.
4. **Report.** Show the final task status and a brief change summary.

## Flags

- `--skip-claim` — do not change assignee/status before coding
- Pass only a task id when possible (`tsk_…`)

## Stops

Ask the user before migrations, destructive ops, or scope expansion beyond the task description.
