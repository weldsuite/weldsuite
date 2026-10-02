---
description: Pull open bug tasks from all WeldSuite projects and produce a prioritized backlog.
---

You are going to produce a prioritized bug backlog for WeldSuite.

The WeldSuite MCP may be registered as `mcp__weldsuite__*` or under a connector
id such as `mcp__2abe9674-…__*`. Match tools by their suffix: `search_projects`, `search_tasks`. Load them
with `ToolSearch` (`+search_projects`, …) if deferred.
Task ids are task numbers like `TASK-734` (the task's `Number` field), not internal `tsk_xxx` ids.

Steps:
1. Call `search_projects` to list all projects.
2. For each project, call `search_tasks` (filter to open/in-progress, type=bug where supported). Since `totalTasks` in the project listing is unreliable, always iterate tasks per project.
3. Collate all open bugs. Group by:
   - **Priority** (blocker → major → minor → cosmetic)
   - **Domain** (weldflow / weldcrm / welddesk / etc., infer from project name or title)
   - **Age** (days since created)
4. Output a table: `| ID | Title | Project | Priority | Age | Suspected domain |`
5. At the end, recommend the top 5 candidates to fix first based on priority × user impact.

Do not dispatch yet. This is a list + recommendation only. The human will decide which to claim via `/fix-bug`.
