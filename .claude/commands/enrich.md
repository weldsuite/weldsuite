---
description: Interview-driven enrichment of a WeldSuite task. Enricher explores the repo, asks you dynamic questions in rounds until context is complete, drafts an "Enriched analysis" block, shows for approval, and pushes via update_task. Does NOT start implementation.
argument-hint: <task-id>
---

Enrich WeldSuite task `$ARGUMENTS` by interviewing me.

1. Invoke the `task-enricher` agent with the task id.
2. Enricher fetches the task, does a first-pass codebase exploration (~10 file reads), then **interviews me** with a dynamic question set, rounds of 1–4 questions at a time via `AskUserQuestion`, informed by what it just found in the code and by my previous answers. No fixed template. No hard cap, it keeps going until context is complete.
3. From round 2 onward, every question set includes an "I've said enough, draft it" option so I can cut the interview short.
4. If the task has a `## Pending interview` block (left by a manual scheduled pre-work run), enricher uses those queued questions as the starting point for round 1.
5. Enricher drafts the "Enriched analysis" block, including a `### Decisions locked in during interview` table that captures every question + my answer verbatim.
6. Draft is shown in chat, I pick `yes` / `edit` / `cancel`.
7. On `yes`: `mcp__weldsuite__update_task` appends the enriched block below the original description (original always preserved). If there was a `## Pending interview` block, it's removed and replaced by the enrichment.
8. On `edit`: revise and re-show.
9. On `cancel`: abort without touching WeldSuite.

Use this when you want to enrich a task but NOT yet implement it. For enrich-then-implement in one shot, run `/fix-bug <task-id>` or `/feature <task-id>`, they run the interview as step 0.

**Idempotent:** if the task is already enriched (description contains `## Enriched analysis`), enricher detects this and skips. Safe to re-run.

**Not interested in being interviewed?** Don't use this command, the interview is the point. For a fully silent pass, click "Run now" on the `weldsuite-autoenrich-hourly` Cowork scheduled task; it does pre-work only (queues questions without drafting) so a later interactive `/enrich` has a head start.
