---
description: Claim a WeldSuite task, assign to current user and flip to in-progress.
argument-hint: <task-id>
---

Claim WeldSuite task `$ARGUMENTS`:

1. `mcp__weldsuite__get_task` to confirm the task exists and read its current state.
2. If already assigned to someone else, print a warning and ask for confirmation before overriding.
3. `mcp__weldsuite__update_task`, set assignee to current user, status to `in_progress`, add a short comment: "Claimed via Claude Code agent workflow".
4. Print a one-line summary: `Claimed: <id>, <title>. Next: run /fix-bug $ARGUMENTS`.

Do not start implementation. Claiming is a handoff step.
