---
name: claim-task
description: Claim a WeldFlow task via WeldSuite MCP — assign to the current user and set in_progress. Use for /claim-task or when the user says claim this task.
disable-model-invocation: true
---

# Claim WeldFlow task

Claim task `$ARGUMENTS`:

1. `get_task` to confirm it exists and read current assignee/status.
2. If assigned to someone else, warn and ask before overriding.
3. `update_task`: set status to `in_progress`, assign to the current user when the API allows, and add a short comment: `Claimed via Cursor WeldSuite plugin`.
4. Print: `Claimed: <id> — <title>. Next: /fix-task <id>`.

Do not start implementation in this skill.
