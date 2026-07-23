# WeldSuite Bug-Fix & Feature Workflow

> **Audience:** WeldSuite engineering team.
> **Owner:** Gert.
> **Last updated:** 2026-05-22.
> **Status:** Active.

A **strict-sequential**, conflict-free way to drain the WeldSuite backlog. Designed because parallel branches were exploding into merge conflicts, double-run Drizzle migrations, and broken realtime / entity-event wiring.

---

## TL;DR, the rule of one

> **One task in flight at a time. PR merged before the next one starts.**

```
                            ┌──────────────────────────┐
                            │   ONE TASK IN FLIGHT     │
                            │   ── across the entire ──│
                            │       repo. Always.      │
                            └──────────┬───────────────┘
                                       │
       ┌───────────────────────────────┴──────────────────────────────┐
       │                                                              │
   ┌───▼────┐  pick highest-pri unstarted task                   ┌────▼─────┐
   │ QUEUE  │  + auto-bundle if root cause overlaps              │  GATES   │
   │        │                                                    │          │
   │ high → │                                                    │ ⛔ DB    │
   │ medium │                                                    │ migration│
   │ → low  │                                                    │ ⛔ can't │
   └───┬────┘                                                    │ reproduce│
       │                                                         │ ⛔ entity│
       │                                                         │ events   │
       ▼                                                         │ catalog  │
   ┌────────┐  ┌─────────┐  ┌─────────┐  ┌────────┐  ┌────────┐  │ ⛔ PR    │
   │ ENRICH ├─▶│DISPATCH ├─▶│ TRIAGE  ├─▶│IMPLEMENT├─▶│  PR   │ │ open    │
   │interview│ │classify │  │root-    │  │+ DoD   │  │+ merge │  └──────────┘
   │user     │ │route to │  │cause +  │  │check   │  │+ close │
   │         │ │special. │  │fix plan │  │        │  │ task   │
   └────────┘  └─────────┘  └─────────┘  └────────┘  └────┬───┘
                                                          │
                                                          ▼
                                              ┌─ pop next from queue ──┐
                                              │   (back to top)        │
                                              └────────────────────────┘
```

---

## Why this exists

Five files in this monorepo are touched by ~30% of all bug-fix branches. If two branches both edit them, the merge is hand-resolved every time:

| Hotspot | Why it conflicts |
|---|---|
| `packages/core/db/src/schema/*` + Drizzle migration folder | Drizzle generates one migration file per run. Two branches → two files with the same number → broken history. |
| `apps/workers/app-api/src/index.ts` | Every new route appends a `.route(...)` line to the same mount block. |
| `packages/core/i18n/src/locales/{en,nl}/*.ts` | Every UI string lands in both locale files. |
| `packages/core/entity-events/src/events/*` | Typed event catalog, any new event extends a union. |
| `apps/web/platform/src/routes/__root.tsx` + provider chain | Cross-cutting state (notifications, presence, realtime) wires through here. |

Running things in series sidesteps all five. We trade wall-clock for sanity.

---

## The pipeline (step by step)

### 0. Pick the next task

- Highest priority first: `critical` → `high` → `medium` → `low` → `none`.
- Within a priority, prefer **bundles**: if 2+ tasks share a root cause (e.g. "avatars wrong in three places"), they go into **one PR**, not three.
- Never pull two tasks at once.

### 1. Enrich (`/enrich <task-id>`)

`task-enricher` agent reads the task and **interviews you** with dynamic questions until the spec is concrete. Appends an `## Enriched analysis` block to the task description.

**Hard gate:** if the enricher asks questions, stop and answer them. Do not write code.

### 2. Dispatch (`weldsuite-dispatcher` agent)

Classifies the enriched task and routes to the correct specialist:

- `frontend-platform` (Vite SPA, `apps/web/platform/`)
- `frontend-nextjs` (sites, portals, helpcenter)
- `mobile-expo` (`apps/mobile/*`)
- `backend-app-api` (✅ new routes go here)
- `backend-workers` (cron / Trigger.dev / agent workers)
- `database` (`packages/core/db/schema/`)
- Domain agents: `weldcrm`, `weldmeet-meetings`, `welddesk-helpdesk`, `weldmail`, `weldflow-projects`, `weldsuite-wms`, `weldhost-domains`, `weldbooks-accounting`, `weldagent-ai`, `weldsuite-social`, `weldsuite-invoicing`, `weldsuite-time-tracking`, `weldchat`, `weldcommerce`

### 3. Triage (`bug-triage` agent, bugs only)

Reproduces the bug locally (or documents why it can't be reproduced). Writes the **fix plan with file paths + line numbers** *before* anyone writes code.

**Hard gate:** if triage can't reproduce, **stop**. Comment on the task asking for repro steps. Do not "fix" a bug you couldn't reproduce.

For features: triage is replaced by a design sketch from the dispatched specialist.

### 4. Implement + DoD

The specialist writes the code in a **new branch off `develop`**, named `fix/<task-id>-<slug>` or `feat/<task-id>-<slug>`.

Definition of Done (run before opening PR):

- [ ] Reproduces before the fix, does **not** reproduce after
- [ ] Tenant scoping (`workspaceId`) on every touched Drizzle query
- [ ] Permission check (`weld*` prefix) on new/changed routes
- [ ] Zod v3 validation on both directions (request + response)
- [ ] i18n entries in **both** `en` and `nl` for any new user-visible string
- [ ] `pnpm lint` passes in changed workspace
- [ ] `pnpm build` of touched app passes
- [ ] No stray `console.log`, `any`, `@ts-ignore`
- [ ] Schema changes flagged to Gert, **no migration files without approval**

### 5. PR → merge → close task (`/done <task-id>`)

- Open the PR against `develop` with WeldSuite task ID in title
- Merge **before** picking up the next task
- `/done` comments on the WeldSuite task with PR URL + flips status to `done`

---

## Hard gates, when work STOPS and asks Gert

| 🛑 Gate | What triggers it | What to do |
|---|---|---|
| **Migration** | About to run `pnpm db:generate` | Stop. Show the schema diff. Wait for `yes`. |
| **Entity events** | About to add to `packages/core/entity-events/src/events/*` | Stop. Show proposed event names + payloads. Wait for `yes`. |
| **Can't reproduce** | Triage can't trigger the bug | Stop. Comment on task with what was tried. Wait for repro steps. |
| **PR open** | A PR is currently in review | Stop. Do **not** start the next task until the open PR is merged or closed. |

---

## Bundling rules

Group into a **single PR** when ≥2 open tasks share **any** of:

- The same module + same kind of bug (e.g. "avatars wrong" across 4 panels)
- The same root cause in shared code (e.g. realtime cache invalidation)
- The same DB schema area (so we can do one migration, not three)
- The same i18n keys

Don't bundle if:

- The risk profile differs (one is a typo fix, one is a refactor)
- The tasks have different reporters and one might want to revert independently
- Total LOC would push the PR over ~600 lines

---

## Branching & rebasing

```
develop ──A───B───C───D────────────────► (main integration branch)
              │
              └── fix/<task-id>-slug ──● open PR ──● merge to develop
                                         │
                                  (rebase on develop
                                   immediately before
                                   pushing if develop
                                   moved while you worked)
```

- Branch off `develop`.
- Rebase on `develop` **just before** opening the PR if `develop` moved.
- Never have two long-lived branches at the same time.

---

## Visual: a day in the life

```
 09:00 ┌─────────────────────────────────────────────────────────────┐
       │  Task #1 (high): "camera black screen on toggle"            │
       │  enrich ──▶ dispatch (weldmeet) ──▶ triage ──▶ implement    │
       │                                                              │
 10:30 │  ✅ PR opened, reviewed, merged. Task closed.                │
       └─────────────────────────────────────────────────────────────┘

 10:31 ┌─────────────────────────────────────────────────────────────┐
       │  Task #2 (high), BUNDLED with 3 more avatar bugs:          │
       │    • mail avatars wrong                                      │
       │    • teammember panel avatars wrong                          │
       │    • meet preview avatars wrong                              │
       │    • crm assignee avatars wrong                              │
       │  enrich ──▶ dispatch (frontend-platform) ──▶ triage          │
       │                                                              │
 13:00 │  ✅ One PR fixes 4 tasks. All 4 closed in `/done`.           │
       └─────────────────────────────────────────────────────────────┘

 13:01 ┌─────────────────────────────────────────────────────────────┐
       │  Task #3 (high): "pipeline templates in crm settings"       │
       │  enrich ──▶ dispatch ──▶ ⚠ NEEDS NEW SCHEMA TABLE           │
       │                          ⛔ HARD STOP, ask Gert            │
       │                                                              │
       │  Gert approves new table.                                    │
       │  ──▶ implement ──▶ PR with migration ──▶ merge.              │
       │                                                              │
 16:30 │  ✅ Closed.                                                  │
       └─────────────────────────────────────────────────────────────┘
```

---

## Quick commands

| Action | Command |
|---|---|
| See current bug backlog | `/list-bugs` |
| Enrich a task only | `/enrich <task-id>` |
| Full fix flow on a bug | `/fix-bug <task-id>` |
| Full feature flow | `/feature <task-id>` |
| Run the loop on the top of the queue | `/autopilot --max 5` |
| Claim a task (assign + in-progress) | `/claim <task-id>` |
| Close a task | `/done <task-id>` |

---

## Anti-patterns (don't do these)

- ❌ Two open PRs from the same person at the same time
- ❌ Generating a Drizzle migration without asking
- ❌ Adding routes to `apps/api-worker` or `apps/core-api` (both obsolete, use `apps/workers/app-api`)
- ❌ Adding Anthropic SDK calls outside `apps/agent-worker`
- ❌ Skipping the `nl` translation when adding a new string
- ❌ "Fixing" a bug you couldn't reproduce
- ❌ Pushing an `## Enriched analysis` block without user approval
- ❌ Editing `apps/web/platform/src/routeTree.gen.ts` by hand
- ❌ Upgrading Zod to v4 in app imports

---

## Reading order for new team members

1. `CLAUDE.md` (repo root), architecture + agent workflow
2. This file, the sequencing rules
3. `.claude/workflows/bug-fix-queue.md`, the live ordered queue
4. `.claude/agents/*`, what each specialist agent does
