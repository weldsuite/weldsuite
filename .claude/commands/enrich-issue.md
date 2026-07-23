---
description: Interview-driven enrichment of a GitHub issue. The enricher explores the repo, asks you dynamic questions in rounds until context is complete, drafts an "Enriched analysis" block, shows it for approval, and writes it into the issue body via `gh issue edit`. Does NOT start implementation. GitHub-issue twin of /enrich (which targets the WeldSuite MCP).
argument-hint: <issue-number> [--auto]
---

Enrich GitHub issue `$ARGUMENTS` by interviewing me.

1. Invoke the `github-issue-enricher` agent with the issue number.
2. The enricher fetches the issue with `gh issue view <number> --json number,title,body,labels,projectItems,comments,assignees,state`, does a first-pass codebase exploration (~10 file reads), then **interviews me** with a dynamic question set, rounds of 1–4 questions at a time via `AskUserQuestion`, informed by what it just found in the code and by my previous answers. No fixed template. No hard cap, it keeps going until context is complete.
3. From round 2 onward, every question set includes an "I've said enough, draft it" option so I can cut the interview short.
4. If the issue body has a `## Pending interview` block (left by a `--auto` batch pass), the enricher uses those queued questions as the starting point for round 1.
5. The enricher drafts the "Enriched analysis" block, including a `### Decisions locked in during interview` table that captures every question + my answer verbatim.
6. The draft is shown in chat; I pick `yes` / `edit` / `cancel`.
7. On `yes`: it reconstructs the new body (original body verbatim, or just the block if the body was empty, below a `---`) and writes it with `gh issue edit <number> --body-file <tmp>`. A `## Pending interview` block, if present, is removed and replaced by the enrichment.
8. On `edit`: revise and re-show.
9. On `cancel`: abort without touching GitHub.

Use this when you want to add full context to a terse GitHub issue BEFORE assigning an agent (local specialist, or the `@claude` GitHub Action) to it, so the assignee inherits the intent, scope, file citations, and acceptance criteria instead of guessing.

**Body only.** The enricher never changes labels, assignee, milestone, project, or state, it only edits the issue body, appending below the original.

**Idempotent:** if the issue body already contains `## Enriched analysis`, the enricher detects this and skips. Safe to re-run.

**Batch pre-work (`--auto`):** `/enrich-issue <number> --auto` runs exploration + drafts a `## Pending interview` block (questions only, no interview, no `## Enriched analysis`) and pushes that. A later interactive `/enrich-issue <number>` picks those queued questions up as round 1. Use this to "do the homework" across a backlog without sitting through interviews, e.g. loop it over the open WeldChat issues.

**Not interested in being interviewed?** Don't use this command, the interview is the point. Use `--auto` for a silent pre-work pass instead.
