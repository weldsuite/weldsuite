---
description: End-to-end fix for a GitHub issue, enricher INTERVIEWS you to spec it, classify, triage (bugs) or sketch (features), specialist implements, full DoD (translations/tests/lint/build/type-check), PR with "Closes #n", Claude review gate. GitHub-issue twin of /fix-bug.
argument-hint: <issue-number> [--skip-enrich]
---

Fix GitHub issue `$ARGUMENTS`. Follow `.claude/ISSUE-FIX-WORKFLOW.md`, read it if you haven't this session.

Run the pipeline:

0. **Enrich, INTERACTIVE INTERVIEW (unless `--skip-enrich`).** Invoke `github-issue-enricher` on the issue number. It explores the repo and interviews you (rounds of 1–4 via `AskUserQuestion`, no hard cap, "I've said enough" escape from round 2), drafts an `## Enriched analysis` block (with a decisions-locked-in table + success criteria), shows it for approval, and writes it into the **issue body** via `gh issue edit` on "yes".
   - Skip only when: (a) `--skip-enrich` passed, or (b) body already contains `## Enriched analysis` (enricher self-skips).
   - If the body has a `## Pending interview` block (from a `--auto` batch pass), the enricher uses those queued questions as round 1.

1. **Branch.** `git checkout develop && git pull`, then `git checkout -b fix/issue-<n>-<slug>` (or `feat/issue-<n>-<slug>`). Never work on `develop` directly.

2. **Classify.** Read the enrichment's **Stack layers touched** + **Suggested specialist chain**. New backend routes → `backend-app-api` (NOT `core-api`/`api-worker`, port legacy routes instead).

3. **Triage (bugs).** Invoke `bug-triage`: reproduce, root-cause, write a fix plan with `path:line` BEFORE coding. If it can't reproduce, comment on the issue requesting info and STOP, don't guess-fix. For features, the specialist produces a short design sketch from the enrichment.

4. **Implement.** Invoke the specialist(s) named by the dispatch chain. Code the plan, nothing more. Keep tenant scoping (`workspaceId`), `weld*` permission checks, Zod v3 both directions, and `publishEntityEvent` on mutation routes intact.

5. **Definition of Done** (see workflow doc §5, a failure is a STOP, not "fix later"):
   - **Translations:** new strings added to `en`, `nl`, `es`, `fr` under `packages/core/i18n/src/locales/`; validate with `pnpm tsx scripts/validate-translations.ts --strict --stable-only` (from `apps/web/platform`).
   - **Tests:** add/update a test for the changed behavior (fails before, passes after). Run the right suite, platform `pnpm test` + `pnpm test:e2e`; mobile `pnpm test` (Jest); workers `pnpm test`. If e2e isn't runnable locally, say so honestly.
   - **Lint:** `pnpm lint` clean in each changed workspace; no new `console.log` / `any` / `@ts-ignore`.
   - **Type-check:** `pnpm --filter app-api type-check` passes (blocking gate). Platform `tsc` OOMs + has ~1100 pre-existing errors, only verify the files you touched, don't chase project-wide zero.
   - **Build:** `pnpm build` of the touched app(s).
   - **Sweep:** `git status` clean; no migration file without user approval; success criteria from the enrichment all met.

6. **PR.** Push the branch and `gh pr create --base develop` with `Closes #<n>` in the body plus a DoD checklist. The **Claude PR review gate** (`claude-review` required check) will run, address its findings, don't route around it.

7. **Close.** `Closes #<n>` auto-closes on merge. For a direct small fix, `gh issue close <n> --comment "Fixed in <sha>. <what changed>."`

**Hard stops, pause and ask:**
- Any database migration file.
- New work landing in `api-worker` / `core-api` (port to `app-api`).
- Anthropic SDK calls outside `agent-worker`.
- A bug you can't reproduce (request info instead).
- Scope creep, file a separate issue and link it; don't bundle.
