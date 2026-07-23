---
description: Pull open bug tasks from all WeldSuite projects and produce a prioritized backlog.
---

You are going to produce a prioritized bug backlog for WeldSuite.

Steps:
1. Call `mcp__weldsuite__search_projects` to list all projects.
2. For each project, call `mcp__weldsuite__search_tasks` (filter to open/in-progress, type=bug where supported). Since `totalTasks` in the project listing is unreliable, always iterate tasks per project.
3. Collate all open bugs. Group by:
   - **Priority** (blocker → major → minor → cosmetic)
   - **Domain** (weldflow / weldcrm / welddesk / etc., infer from project name or title)
   - **Age** (days since created)
4. Output a table: `| ID | Title | Project | Priority | Age | Suspected domain |`
5. At the end, recommend the top 5 candidates to fix first based on priority × user impact.

Do not dispatch yet. This is a list + recommendation only. The human will decide which to claim via `/fix-bug`.
