---
description: Claim a WeldSuite task, assign to current user and flip to in-progress.
argument-hint: <task-id>
---

Claim WeldSuite task `$ARGUMENTS`:

The WeldSuite MCP may be registered as `mcp__weldsuite__*` or under a connector
id such as `mcp__2abe9674-…__*`. Match tools by their suffix: `get_task`, `update_task`. Load them
with `ToolSearch` (`+get_task`, …) if deferred.
Task ids are task numbers like `TASK-734` (the task's `Number` field), not internal `tsk_xxx` ids.

1. `get_task` to confirm the task exists and read its current state.
2. If already assigned to someone else, print a warning and ask for confirmation before overriding.
3. `update_task`, set assignee to current user, status to `in_progress`, add a short comment: "Claimed via Claude Code agent workflow".
4. Print a one-line summary: `Claimed: <id>, <title>. Next: run /fix-bug $ARGUMENTS`.

Do not start implementation. Claiming is a handoff step.
