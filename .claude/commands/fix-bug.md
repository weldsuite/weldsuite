---
description: End-to-end: enricher INTERVIEWS you to spec the bug, dispatcher classifies, triage reproduces + roots-causes, specialist implements, DoD checks, task closed.
argument-hint: <task-id> [--skip-enrich]
---

Fix WeldSuite bug `$ARGUMENTS`.

Run the standard agent pipeline:

0. **Enrich, INTERACTIVE INTERVIEW (unless `--skip-enrich` is passed).** Invoke `task-enricher` on the task id. Enricher explores the repo and interviews you with a dynamic set of questions (rounds of 1–4 via `AskUserQuestion`, no hard cap, "I've said enough" escape from round 2). Drafts an "Enriched analysis" block with a decisions-locked-in table, shows for approval, appends via `update_task` on "yes".
   - Skip step only when: (a) `--skip-enrich` is passed, or (b) description already contains `## Enriched analysis` (enricher self-skips).
   - If description contains `## Pending interview` (left by a manual batch pre-work run), enricher uses those queued questions as round 1.
1. Invoke `weldsuite-dispatcher`. Dispatcher reads the now-enriched task, the interview locked in scope, UX, data model, etc., so the dispatcher's job is easier.
2. Invoke `bug-triage`. Triage reproduces, traces to root cause, writes a fix plan. It leans on the enricher's "Existing patterns to mirror" and "Decisions locked in".
3. Invoke the specialist(s) named by the dispatcher. They implement against the triage plan, nothing more, nothing less.
4. Run Definition-of-Done checks (see CLAUDE.md):
   - `pnpm lint` in the changed workspace(s)
   - `pnpm build` of the touched app(s)
   - Tenant scoping on every Drizzle query touched
   - Permission check on any route touched
   - i18n keys added to both `en.json` and `nl.json` if UI strings changed
5. Call `mcp__weldsuite__update_task` with a comment linking the commit/PR and flip status to done (or `in_review` if a PR was opened).

Stop and ask before:
- Creating any database migration file
- Touching `apps/api-worker` for something that looks like new work (belongs in `apps/core-api`)
- Changing anything in another specialist's domain beyond the scope of the triage plan
