---
name: weldtask
description: "Fix or build one WeldSuite task end-to-end from its number. Use when the user types /weldtask <number> (TASK-734, 734, #734, or a task title), or asks to fix / work on / implement a specific WeldSuite task. Resolves the task via the WeldSuite MCP, decides per task how much to interview, triages, implements through the specialist agents, runs the Definition of Done, opens a PR against develop and updates the task. Asks the user whenever it is blocked or a decision is theirs."
argument-hint: <task-number> [--no-interview] [--interview]
---

# /weldtask: one WeldSuite task, start to PR

Input: `$ARGUMENTS`. The first token is the task, the rest are flags:

- `--interview`: always run the full interview, even for a clear task.
- `--no-interview`: never run the full interview. Still ask when blocked.

Accepted task forms: `TASK-734`, `task-734`, `734`, `#734`, a task title, or the
internal id. No argument → ask which task (offer the top 4 open tasks by priority
from `search_tasks` as options).

**The user only answers questions.** Every question goes through `AskUserQuestion`
in this (main) session, with a recommended option first. Subagents cannot reach
the user: when a subagent comes back with an open question, ask it here, then
continue that agent with `SendMessage` (same agent id, context intact).

## WeldSuite MCP tool names

The WeldSuite MCP may be registered as `mcp__weldsuite__*` or under a connector
id such as `mcp__2abe9674-…__*`. Match tools by their suffix: `get_task`,
`search_tasks`, `update_task`, `create_task_comment`, `search_task_comments`,
`create_task`. Load them with `ToolSearch` (`+get_task`, …) if deferred. If no
WeldSuite tools exist at all, stop and tell the user the connector is missing.

Talk about the task by its number and title, never its internal id.

## 1. Resolve the task

1. Call `get_task` with the number exactly as typed (normalise `734` / `#734` to
   `TASK-734`). The MCP server resolves task numbers exactly.
2. If that errors or returns a different number (an older deployed MCP server
   fuzzy-matches on titles), fall back: `search_tasks({ search: "TASK-734" })`,
   keep only the row whose `Number:` is exactly `TASK-734`, and call `get_task`
   with that row's internal id (from the `<!--id=…-->` comment).
3. Still nothing, or several title matches → ask the user which task is meant.

Also read the task's comments (`search_task_comments` filtered on the task) and
any parent task. A comment may answer questions the description leaves open.

Stop and ask if the task is `done`, `cancelled` or `in_review`, or is assigned
to someone else ("Work on it anyway?" / "Pick another task" / "Stop").

## 2. Decide how much to ask (per task)

Classify the task first: **bug** (`type: bug`, or the text describes broken
behaviour) or **feature** (everything else).

Then score clarity. The task is **clear** when all of these hold:

- Bug: what happens, what should happen, and where (page, endpoint, app) are all
  stated or can be found in the code within a few reads.
- Feature: the scope fits one module, the surface (which page / endpoint /
  worker) is named or obvious, and there is no open product or UX decision.
- Or: the description already has a `## Enriched analysis` block.

| Situation | What to do |
|---|---|
| Clear (or `--no-interview`) | No interview. Ask only targeted questions (one round of up to 4) about anything that would change the implementation. Often zero. |
| Vague, a feature with open UX / data-model choices, or touches several modules (or `--interview`) | Full interview, following the procedure in `.claude/agents/task-enricher.md`, run **in this session** so the questions reach the user: explore (~10 reads), ask rounds of 1–4 questions, draft the `## Enriched analysis` block, show it, and append it to the task via `update_task` only after the user approves (append-only, below `---`). |
| Description has `## Pending interview` | Use those queued questions as round 1, then decide as above. |

Before starting a full interview, tell the user in one line why ("The task
doesn't say which page this is on or what the expected result is").

## 3. Claim and branch

1. `update_task`: status `in_progress`, and assign the current user if the task
   is unassigned. Add a short comment: "Picked up via /weldtask".
2. Git, from the repo root:
   - Uncommitted changes in the working tree → ask: "Stash them" / "Commit them
     first" / "Stop". Never discard them.
   - `git fetch origin develop`, then
     `git switch -c weldtask/task-<n>-<short-slug> origin/develop`.
     If the branch already exists, ask whether to reuse it.

## 4. Triage

Run the `bug-triage` agent (foreground) with the task number, title, full
description (including any enrichment), relevant comments, and the answers the
user gave.

- **Bug**: reproduce, find the root cause, write a fix plan with file paths and
  lines.
- **Feature**: design sketch: new/changed routes, UI, schema, jobs, and which
  specialist owns each slice.

If triage cannot reproduce a bug, ask:
"Give more info" (ask what exactly is missing) / "Mark the task needs-info and
stop" (comment on the task with what is needed) / "Fix it anyway from the code".

Show the user a 3–6 line summary of the plan. For a feature, or a fix that
touches more than ~5 files, ask "Go ahead with this plan?" before implementing.
For a small, clear bug fix, just continue.

## 5. Implement

Pick specialists from the plan (or run `weldsuite-dispatcher` when unclear).
Order: `database` → `backend-app-api` / `backend-workers` → `frontend-platform` /
`frontend-nextjs` → `mobile-expo`, plus the domain agent (`weldcrm`,
`welddesk-helpdesk`, `weldflow-projects`, …) when the logic is module-specific.
Run them in the foreground, one after another, each with the task, the
enrichment, the triage plan and what earlier specialists changed. Tell each
agent: "If you hit a decision that isn't in the plan, stop and return the
question instead of guessing."

**Hard stops. Always ask the user first:**

- Creating a database migration file (`db:generate`). Options: "Generate the
  migration" / "Schema change only, no migration" / "Stop".
- A new DB table, new package, new app or new worker.
- Putting a module route in `apps/workers/app-api` instead of
  `apps/workers/<module>-api`, or a new path prefix in
  `packages/core/api-modules`.
- Work beyond the task's scope. An adjacent bug found along the way gets a new
  task via `create_task` (ask first), not a silent fix.
- Anything touching secrets, production config, deletes of user data, or
  billing behaviour.
- The plan turns out to be wrong (root cause is elsewhere, needs another
  module's API).

## 6. Definition of Done

Run in the touched workspaces and fix what fails (up to 3 attempts per check,
then ask the user how to proceed):

- `pnpm --filter <ws> lint`
- `pnpm --filter <ws> type-check` (or `tsc --noEmit`)
- `pnpm --filter <ws> test` where the workspace has tests. Add or extend a test
  that fails before the fix and passes after when the workspace has a test setup.
- `pnpm --filter <app> build` for touched apps (platform: `pnpm --filter platform build`).
- Bug: confirm the reproduction from triage no longer reproduces. For visible
  platform UI, verify in the browser preview per the session's preview workflow.

Review the diff yourself for:

- `workspaceId` / tenant scoping on every touched query
- a `weld*` permission check on every new or changed route
- `publishEntityEvent` on every new mutation route (except WeldPass)
- Zod v3 validation both ways
- every new user-visible string in both `en/` and `nl/` under
  `packages/core/i18n/src/locales/`
- no `console.log`, `any`, or `@ts-ignore`; no edits to `routeTree.gen.ts`

Errors that already exist on `develop` in files you didn't touch: mention them,
don't fix them.

Then run `graphify update .` if `graphify-out/graph.json` exists.

## 7. Commit, PR, update the task

1. Stage only the files this task changed. Commit as
   `fix(<module>): <summary> (TASK-<n>)` for a bug or
   `feat(<module>): <summary> (TASK-<n>)` for a feature, ending with the
   session's commit attribution lines.
2. `git push -u origin <branch>`, then `gh pr create --base develop` with:
   title = the commit subject; body = the task number and title, root cause (bug) or
   what was built (feature), changes per area, how it was verified, any schema
   change / migration, follow-ups, and the session's PR attribution line.
3. Bind and check the PR with the app's PR tools (`get_status` / `bind_pr`).
4. `create_task_comment` on the task: PR link, a 2–4 line summary, and anything
   the reviewer must know (migration, env var, manual step). Then
   `update_task` status `in_review`.

## 8. Report

End with a short summary: task number and title, what was wrong / built, the PR
link, checks run and their results, anything skipped and why, and follow-up
tasks created.

## Recovering from failures

- A specialist fails or produces nothing → retry once with the error included,
  then ask the user.
- `gh` not authenticated or push rejected → commit locally, tell the user the
  exact command to run, and still comment on the task.
- The MCP refuses an update (permission) → say so; don't retry.
