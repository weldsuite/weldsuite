# GitHub Issue → Fix Workflow

How to take a WeldSuite GitHub issue from a terse one-liner to a merged, verified fix, without skipping translations, tests, or lint. This is the GitHub-issue counterpart to the WeldSuite-MCP `/fix-bug` flow. Run it end-to-end with `/fix-issue <number>`, or follow the stages by hand.

> **Why this exists:** most issues are migrated WeldSuite tasks, terse, often Dutch, empty body (e.g. #1052 *"wanneer message verstuurd wordt zit er een delay in"*). An agent assigned to a bare title guesses. This workflow front-loads context (enrichment) and back-loads verification (DoD) so the fix is right *and* mergeable.

---

## Pipeline at a glance

```
0. Enrich      /enrich-issue <n>        → context written into the issue body
1. Branch      fix/issue-<n>-slug       → never work on develop directly
2. Classify    github-issue-enricher's "Suggested specialist chain" → pick specialist(s)
3. Triage      reproduce + root-cause   → fix plan BEFORE code (bug-triage agent)
4. Implement   specialist agent(s)      → code the plan, nothing more
5. DoD         translations/tests/lint/build/type-check  → see checklist below
6. PR          gh pr create … "Closes #n"  → Claude review gate must pass
7. Close       merge (auto-closes the issue) or gh issue close with a comment
```

Each stage feeds the next. Skipping stage 0 makes every later stage guess; skipping stage 5 makes the PR bounce off CI and the review gate.

---

## 0. Enrich (always first)

```
/enrich-issue <number>
```

The `github-issue-enricher` explores the repo, interviews you, and appends an `## Enriched analysis` block to the **issue body** (domain, stack layers, file citations with line numbers, locked-in decisions, scope boundaries, success criteria). Self-skips if already enriched. For a terse Dutch title this is where intent, "is this mobile or platform?", and acceptance criteria get pinned down.

The enrichment's **Suggested specialist chain** and **Success criteria** drive stages 2–4 and the DoD in stage 5.

---

## 1. Branch

Never commit to `develop` directly. Branch first:

```bash
git checkout develop && git pull
git checkout -b fix/issue-<n>-<short-slug>      # bug
git checkout -b feat/issue-<n>-<short-slug>     # feature
```

---

## 2. Classify → pick the specialist

Read the enrichment's **Stack layers touched** + **Suggested specialist chain**. Map to agents:

| Layer | Agent | Tests that gate it |
|---|---|---|
| `apps/web/platform` (web SPA) | `frontend-platform` | vitest + Playwright e2e |
| `apps/mobile/<app>` | `mobile-expo` | Jest |
| New API endpoint | `backend-app-api` | `pnpm type-check` (app-api is the blocking gate) |
| Legacy route bugfix | `backend-api-worker-legacy` / `backend-core-api` | **port to app-api instead** when feasible |
| Non-API workers (billing, workspace, realtime, integration…) | `backend-workers` | worker's own tests |
| Schema / migration | `database` | **ask before any migration file** |
| Domain logic | `weldchat-module`, `weldcrm`, `weldmail`, `weldbooks-accounting`, … | per-domain |

> **New backend routes go in `apps/workers/app-api`.** `core-api` and `api-worker` are obsolete, if the closest code lives there, port the route rather than patching in place.

---

## 3. Triage (bugs)

For bugs, run `bug-triage` BEFORE writing code: reproduce (or document why you can't, then **request info, don't guess-fix**), trace to root cause, write a fix plan with `path:line`. For features, the specialist produces a short design sketch from the enrichment instead.

---

## 4. Implement

The specialist codes the triage plan, nothing more, nothing less. Match the surrounding code's idioms. While coding, keep the DoD in mind so you don't backfill it later:

- **Tenant scoping:** every Drizzle query you touch keeps its `workspaceId` filter.
- **Permissions:** any new/changed route has a `weld*` permission check (`requirePermission()`).
- **Validation:** Zod **v3** on both request and response (never upgrade imports to v4).
- **Entity events:** every mutation route publishes an entity event (`publishEntityEvent`).
- **Strings:** any new user-visible string goes through i18n, no hardcoded copy (see DoD §Translations).

---

## 5. Definition of Done, the checklist

Run these in the workspace(s) you touched. **A failure here is a STOP, not a "fix later."**

### Translations (i18n)

Locales live in **`packages/core/i18n/src/locales/`**, `en` (source of truth), `nl`, `es`, `fr` (each a folder with an `index.ts`). Any new user-visible string MUST exist in **every stable locale**, not just English.

- Add the key to `en` first (source), then `nl`, `es`, `fr`.
- Validate parity from `apps/web/platform`:
  ```bash
  pnpm tsx scripts/validate-translations.ts --strict --stable-only
  ```
  `--stable-only` skips locales flagged experimental in `localeConfig`; `--strict` fails on any missing/orphan key. Use `--fix` to emit patch files listing gaps.
- No raw literals in JSX/markup, route copy through `getTranslations(...)` / the i18n helpers.

> CLAUDE.md still says "en/nl only", reality moved to the 4-locale `@weldsuite/i18n` package. Treat `en + nl + es + fr` as the parity set unless `--stable-only` skips one.

### Tests

| Workspace | Command | Notes |
|---|---|---|
| `apps/web/platform` (unit) | `pnpm test` | vitest |
| `apps/web/platform` (e2e) | `pnpm test:e2e` | Playwright, Chromium only; needs platform on :3000, `app-api` running, `.env.test` with `TEST_USER_EMAIL`/`TEST_USER_PASSWORD`. Single spec: `pnpm exec playwright test e2e/specs/<area>/<file>.spec.ts` |
| `apps/mobile/<app>` | `pnpm test` | Jest |
| Workers | `pnpm test` (where present) | per-worker vitest |

Add or update a test for the behavior you changed. A bug fix should ship with a test that **fails before, passes after**. If e2e infra isn't runnable locally, say so explicitly in the PR, don't claim a green run you didn't do.

### Lint

```bash
pnpm lint            # in each changed workspace (turbo scopes it)
```

No new `console.log`, `any`, or `@ts-ignore` introduced.

### Type-check

- **`app-api`** is the blocking gate and is clean, `pnpm --filter app-api type-check` must pass.
- **`apps/web/platform`** `tsc --noEmit` OOMs at the default 4 GB (needs `NODE_OPTIONS=--max-old-space-size=8192`) and carries ~1100 pre-existing errors, it is **not** a green gate. Only verify the files you touched are error-free; don't try to drive the whole project to zero.

### Build

```bash
pnpm build           # of the touched app(s)
```

### Final sweep

- `git status` clean (no stray files, no committed `node_modules`, no debug artifacts).
- Schema change? It's edited in `packages/core/db/src/schema/` only, **no migration file without explicit user approval.**
- Re-read the enrichment's **Success criteria**: does the change satisfy each one?

---

## 6. Open the PR

```bash
git push -u origin fix/issue-<n>-<slug>
gh pr create --base develop \
  --title "<type>(<scope>): <summary> (#<n>)" \
  --body "Closes #<n>

## What
<one-paragraph summary>

## DoD
- [x] Translations: en/nl/es/fr parity (validate-translations --strict --stable-only)
- [x] Tests added/updated and run (<which suites>)
- [x] pnpm lint clean in <workspace>
- [x] pnpm build of <app> passes
- [x] Tenant scoping + permission check preserved on touched routes
- [ ] e2e not run locally (no .env.test)   ← only if true; be honest
"
```

- **`Closes #<n>`** in the body auto-closes the issue when the PR merges, that's stage 7 for free.
- The **Claude PR review gate** runs on every PR; a required `claude-review` status check HARD-blocks merge on `develop` and `main`. Address its findings, don't try to route around it.
- The develop→main promotion is gated by the Production branch ruleset checks (`Unit · *`, `Type Check · app-api`, `E2E Tests`), so keep those green.

---

## 7. Close

- **Via PR merge:** if the body had `Closes #<n>`, merging closes the issue automatically. Done.
- **Direct commit (rare, small fixes on develop):**
  ```bash
  gh issue close <n> --comment "Fixed in <commit-sha>. <one-line what changed>."
  ```
- Move the issue's project card to the right column if it didn't move automatically.

---

## Hard stops, pause and ask the user

1. **Any database migration file.** Edit schema freely; never generate/commit a migration without approval.
2. **New work landing in `api-worker` or `core-api`.** Both are obsolete, port to `app-api`.
3. **Anthropic SDK calls outside `agent-worker`.** Proxy via the `AGENT_WORKER` binding.
4. **A bug you can't reproduce.** Request info on the issue; don't ship a speculative fix.
5. **Scope creep.** Found a nearby bug? File a separate issue (`gh issue create`) and link it, don't bundle.

---

## One-shot

```
/fix-issue <number>            # enrich → branch → triage → implement → DoD → PR → close
/fix-issue <number> --skip-enrich   # only if the issue already has ## Enriched analysis
```
