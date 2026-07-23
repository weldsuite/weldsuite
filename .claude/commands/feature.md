---
description: Implement a WeldSuite feature end-to-end: enricher INTERVIEWS you to spec the feature, dispatcher classifies, specialists design + implement, DoD checks, task closed.
argument-hint: <task-id> [--skip-enrich]
---

Implement WeldSuite feature `$ARGUMENTS`.

Differences from `/fix-bug`:
- Skip the "reproduce" step in triage, no bug. Triage instead produces a **design sketch** from the enriched description: what new routes / UI / schema / jobs are needed, and which specialists own each slice.
- Dispatcher may name **multiple specialists**, sequence in obvious dependency order: database → backend → frontend → mobile.
- Stop and ask before adding a new DB table, new top-level app folder, or new package.

Pipeline:

0. **Enrich, INTERACTIVE INTERVIEW (unless `--skip-enrich` is passed).** Invoke `task-enricher`. Because features are always under-specified at creation, the interview is where scope, UX placement, data model, auth, success criteria all get pinned down. Rounds of 1–4 questions via `AskUserQuestion`, no hard cap, "I've said enough" escape from round 2. Drafts "Enriched analysis" with decisions table, shows for approval, appends via `update_task`.
   - Skip only when: (a) `--skip-enrich`, or (b) `## Enriched analysis` already present.
   - If description has `## Pending interview`, those questions seed round 1.
1. `weldsuite-dispatcher`, fetch the enriched task, classify, emit plan. Use the enricher's suggested specialist chain as a strong hint.
2. `bug-triage`, produce a design sketch + file map. The enricher's decisions table gives triage a head start.
3. Walk specialist chain in dependency order. Each specialist reads the enrichment + triage plan + prior specialists' output.
4. DoD checks (see CLAUDE.md).
5. `mcp__weldsuite__update_task` with PR/commit comment, flip to `in_review` or `done`.

Never go beyond the feature scope defined in the enriched task description. If you notice an adjacent issue, file a new task via `mcp__weldsuite__create_task`, do not silently bundle.
