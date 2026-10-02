---
description: Close out a WeldSuite task, run DoD checks, comment on task, flip status.
argument-hint: <task-id> [pr-url-or-commit-sha]
---

Close out WeldSuite task `$ARGUMENTS`.

The WeldSuite MCP may be registered as `mcp__weldsuite__*` or under a connector
id such as `mcp__2abe9674-…__*`. Match tools by their suffix: `update_task`. Load them
with `ToolSearch` (`+update_task`, …) if deferred.
Task ids are task numbers like `TASK-734` (the task's `Number` field), not internal `tsk_xxx` ids.

Steps:

1. Run Definition-of-Done checks (see CLAUDE.md):
   - `pnpm lint` in the changed workspace(s)
   - `pnpm build` of the touched app(s)
   - `git status` clean (no stray files)
   - No introduced `console.log`, `any`, or `@ts-ignore`
2. If any check fails, STOP, print the failure and do not update the task.
3. `update_task` on the task:
   - Add a comment with the PR URL or commit SHA from the arguments
   - Flip status to `in_review` if it's a PR, `done` if it's a direct commit to main
4. Print a one-line confirmation: `Closed: <id>. Status: <new status>. URL: <pr-or-commit>`.

Do not mark done without passing lint/build. If the user insists, tell them to override explicitly, don't auto-skip.
