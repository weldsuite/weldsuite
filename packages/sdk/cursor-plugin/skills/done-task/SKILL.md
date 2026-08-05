---
name: done-task
description: Close out a WeldFlow task after verification — comment with PR/commit and flip status via WeldSuite MCP. Use for /done-task.
disable-model-invocation: true
---

# Done — close WeldFlow task

Close out task from `$ARGUMENTS` (format: `<task-id> [pr-url-or-commit]`).

## Steps

1. Confirm local work is in good shape for this repo (project lint/tests/type-check as applicable; `git status` for stray files).
2. If verification fails, STOP — print the failure and do not update the task.
3. `update_task` on the task id:
   - Comment with the PR URL or commit SHA when provided
   - Status `in_review` if a PR URL was given, else `done`
4. Print: `Closed: <id>. Status: <status>. Ref: <pr-or-commit-or-n/a>`.

Do not mark done without verification unless the user explicitly overrides.
