---
description: Fetch the top 10 most important WeldSuite tasks right now, generate a ready-to-paste `claude -p` prompt for each, and let me pick which one to start.
---

You are running the `/queue` slash command. Goal: surface the user's top 10 tasks live from WeldSuite and let them pick one to work on.

## Default user

`user_3984pBydzNbnt1KVhOHY5fZYzqq` (Gert), unless the user explicitly passes a different `user_…` ID after `/queue`.

## Steps

### 1. Fetch live tasks

Call `mcp__weldsuite__search_tasks` **five times in parallel** to cover every open status (the MCP's 50-result limit means you must query each status separately):

- `{ assigneeId, status: "todo", limit: 50 }`
- `{ assigneeId, status: "in_progress", limit: 50 }`
- `{ assigneeId, status: "in_review", limit: 50 }`
- `{ assigneeId, status: "testing", limit: 50 }`
- `{ assigneeId, status: "backlog", limit: 50 }`

If any `todo` response returns exactly 50 (likely), also call once per priority band to make sure you didn't truncate: `{ assigneeId, status: "todo", priority: "critical" | "high" | "medium" | "low" | "none", limit: 50 }`.

De-duplicate by task ID after combining.

### 2. Rank to top 10

Sort by this priority order:

1. `status === "in_progress"` first (there's already a branch, finish it before starting new work)
2. Then by priority: `critical` → `high` → `medium` → `low` → `none`
3. Then `type === "bug"` before `task` / `feature` / `story` within the same priority
4. Then by `id` descending (newer first) as a tiebreaker

Take the **top 10**.

### 3. Detect probable hard-gates

For each task, set `gate: true` when ANY of these match its title (case-insensitive):

- `schema`, `migration`, `database`
- `role[\s-]?based`, `permissions`
- `pipeline template`, `breakout room`, `entity[- ]event`
- `groep call`, `voice channel`, `inbound call`

These will need schema or entity-events approval, flag them visually with 🛑.

Also flag `bundle: true` if you can see 2+ tasks in the top-10 that obviously share a root cause (e.g. multiple "avatar" bugs, multiple "notifications" issues). Show them grouped if so, but only count them as 1 of the 10 slots.

### 4. Render the table

Output a single, scannable table. Example shape:

```
#  Pri   Status        Module        Task ID                       Title
1  🟥    in_progress   WeldCRM       task_movy7a7869chvvvz         Pipeline templates in CRM settings  🛑
2  🟥    todo          WeldMeet      task_mp5wxyqptmmkejfy         Camera bug
3  🟥    todo          WeldMail      task_mooflyhkrpm9fu2u         Avatars wrong in mail application  🧷 (bundle: 4)
...
```

Then under the table, for each row, show a copy-pasteable command:

```
# Task 1
claude -p '/fix-bug task_movy7a7869chvvvz'

# Task 2
claude -p '/fix-bug task_mp5wxyqptmmkejfy'

# Task 3 (bundle, covers task_mooflyhkrpm9fu2u, task_mon1xkcxj4g1x83z, task_mp5wyw9tsy2ysszh)
claude -p 'I want to fix a bundle of 3 related avatar bugs in one PR: task_mooflyhkrpm9fu2u, task_mon1xkcxj4g1x83z, task_mp5wyw9tsy2ysszh. Run /fix-bug on the first one to enrich + triage, then apply the same fix pattern to the other two in the same branch.'
```

Use **single-quoted** strings (PowerShell style) since the user is on Windows. Escape inner single quotes by doubling them (`''`).

If a task is a hard-gate (`🛑`), append this line to its prompt:

```
# ⚠ Schema/entity-events gate likely. Claude will stop and ask before generating any migration.
```

### 5. Ask which task to start

Use `AskUserQuestion` with exactly these options (max 4, "Other" lets the user type a task number):

1. **"Start #1"**, `description`: the title of task #1
2. **"Start #2"**, `description`: the title of task #2
3. **"Start #3"**, `description`: the title of task #3
4. **"Show me 10 more"**, `description`: fetch the next 10 by priority

When the user picks "Show me 10 more": re-run with `offset: 10` (items 11–20).

When the user picks "Other" and types something like "copy #5 prompt": print just that single prompt and stop. **Skip the context-gathering step**, they want the raw prompt for copy/paste.

### 6. Context-gathering, REQUIRED before invoking `/fix-bug`

When the user picks **Start #N** in interactive mode, do NOT call `/fix-bug` yet. The user always wants to add extra context first.

First, echo the selected task so they know which one they're attaching context to:

```
> Selected: task_xxxxxx, "<title>"
> Project: <module>   Priority: <prio>   Status: <status>

Add anything that isn't obvious from the title. Skip any field by selecting "Done, generate the prompt".
```

Then loop on `AskUserQuestion` until the user picks "Done". Each iteration, present these 4 options:

1. **"Steps to reproduce"**, `description`: "URL, click path, account, role, browser. Multi-line ok via Other."
2. **"Expected vs actual"**, `description`: "What should happen vs what does happen"
3. **"Files / pages / suspected area"**, `description`: "Any file paths, page URLs, or modules you suspect"
4. **"Done, generate the prompt"**, `description`: "Skip remaining fields and start work"

The user picks one slot, then either selects a sensible default *description* you offer in `Other`, or types a custom value. Store each filled field. Re-ask the question with the remaining slots (drop the one they just answered, keep "Done"). Stop when they pick "Done" or all 3 content slots are filled.

After "Done", ask one final `AskUserQuestion` for **scope**:

1. **"Find root cause + fix"**, `description`: "Spend time on triage, fix the underlying issue (recommended)"
2. **"Quick fix only"**, `description`: "Just patch the visible symptom, no refactor"
3. **"Bundle with similar bugs"**, `description`: "If you see related open tasks, fix them in the same PR"
4. **"Spec it out, don't implement yet"**, `description`: "Stop after triage so I can review"

### 7. Generate the prompt with attached context

Construct the dispatch prompt. Format it exactly like this so the enricher subagent can parse and skip already-answered questions:

```
/fix-bug <task-id>

## Extra context attached at queue-time

**Steps to reproduce:**
<their input, or ", " if skipped>

**Expected vs actual:**
<their input, or ", ">

**Files / pages / suspected area:**
<their input, or ", ">

**Scope:** <root-cause | quick-fix | bundle | spec-only>
```

Then act based on scope:

- **root-cause / quick-fix / bundle** → invoke `/fix-bug <task-id>` with the context block as the leading message. The enricher reads it and won't re-ask questions you already answered.
- **spec-only** → invoke `/enrich <task-id>` instead. Stops after triage.

If a hard-gate flag was present on the task (🛑), append a sentence to the context: `> ⚠ This task is flagged as a likely schema/entity-events gate. Stop and ask before generating any migration or extending the events catalog.`

### 8. Hard rules, never break these

- **One task in flight.** If step 2 found anything in `in_progress`, the table must put it at #1 and the question must default-recommend finishing that before starting anything new. Mention this in a sentence above the question.
- **Never auto-start work without confirmation.** Always go through `AskUserQuestion` before invoking `/fix-bug`. The user runs this command to *see* the queue, not to commit to work.
- **Don't bundle aggressively.** Only group tasks when the overlap is unambiguous (avatars, notifications, realtime invalidation, calendar). When in doubt, keep them separate, easier to revert.
- **Strip newlines from titles** in the output table. Many WeldSuite titles end with `\n` and break the layout.
- **Don't summarise the work after rendering.** End with the AskUserQuestion. The user wants the table + prompts + a choice, not a recap.

## Example session

```
User: /queue

Assistant fetches via MCP, ranks, and renders:

#  Pri   Status        Module        Task ID                       Title
1  H     in_progress   WeldFlow      task_mo35kz3u7abmh1uo         Github connection  (overdue)
2  H     todo          WeldCRM       task_movy7a7869chvvvz         Pipeline templates in crm settings  GATE
3  H     todo          WeldMeet      task_mp5wxyqptmmkejfy         Camera bug
...

Then the prompt commands, then AskUserQuestion:
  - "Start #1" (Github connection, already in_progress, finish first)
  - "Start #2" (Pipeline templates)
  - "Start #3" (Camera bug)
  - "Show me 10 more"
```
