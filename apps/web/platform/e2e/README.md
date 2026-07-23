# E2E test suite

Playwright suite of ~56 spec files (~475 test cases after parameterized route loops expand) covering every route, every primary action button, and the seed-driven CRUD flows. To make the suite fully operational against a real environment you need to wire three secrets, one for the worker, three for GitHub Actions, and provision one Clerk workspace. The whole thing is ~5 minutes once you have the credentials.

## Architecture

```
┌─────────────────┐   storageState   ┌──────────────────┐
│ auth.setup.ts   │ ───────────────► │  chromium        │
│ (Clerk login)   │                  │  (auth'd specs)  │
└─────────────────┘                  └──────────────────┘
                                              │
                                              │ X-Test-Token
                                              ▼
                          ┌──────────────────────────────┐
                          │ apps/workers/app-api /test-fixtures  │
                          │ • POST /reset                │
                          │ • POST /seed/<entity>        │
                          │ • DELETE /entity/:type/:id   │
                          └──────────────────────────────┘
                                              │
                                              ▼
                                      ┌────────────────┐
                                      │ Neon tenant DB │
                                      │ (test env)     │
                                      └────────────────┘
```

The two-layer guard on `/test-fixtures/*` (`ENVIRONMENT !== 'production'` **AND** `X-Test-Token` matches) means production deploys are never at risk: the route 404s in production even with a stolen token.

## Setup checklist

### 1. Provision a dedicated test workspace

You need a Clerk organization that exists only for E2E. Don't reuse a human workspace, `/reset` wipes rows by marker, but a stray manual delete can poison the suite.

- In the **test environment** Clerk dashboard, create an org named e.g. `WeldSuite E2E`.
- Have the platform sign in once with `TEST_USER_EMAIL` (e.g. `e2e@example.com`) and create the workspace via the onboarding flow.
- Grab the workspace's Clerk org id (looks like `org_2N…`).

### 2. Set the worker secret

```bash
cd apps/workers/app-api

# Generate a random token (or use openssl rand -hex 32)
TOKEN=$(node -e "console.log(crypto.randomBytes(32).toString('hex'))")
echo "$TOKEN"   # save this, you'll paste it into GitHub Actions too

wrangler secret put TEST_FIXTURES_TOKEN --env test     # paste $TOKEN
wrangler secret put TEST_FIXTURES_TOKEN --env preview  # paste $TOKEN
```

The `production` env intentionally does NOT get this secret. The router's `ENVIRONMENT !== 'production'` guard is the belt; the missing secret is the braces.

### 3. Set the GitHub Actions secrets

In `Settings → Secrets → Actions` on the repo, add:

| Secret | Value |
|---|---|
| `TEST_FIXTURES_TOKEN` | the `$TOKEN` from step 2 |
| `TEST_API_URL` | `https://app-api-test.weldsuite.org` (or `https://app-api-preview.weldsuite.org` for preview env) |
| `TEST_WORKSPACE_ID` | the `org_…` id from step 1 |

These three are read by both `pr-checks.yml` (`e2e-tests` job) and `deploy.yml` (`tests` job).

### 4. Wire the local `.env.test`

```bash
# apps/web/platform/.env.test
TEST_API_URL=http://localhost:8789       # or https://app-api-test.weldsuite.org
TEST_FIXTURES_TOKEN=<same as above>
TEST_WORKSPACE_ID=<same as above>
```

## Running the suite

### Locally

```bash
# Terminal 1: Vite SPA on :3000
cd apps/web/platform && pnpm dev

# Terminal 2 (optional, only for fully-local mode): wrangler dev on :8789
cd apps/workers/app-api && pnpm dev

# Terminal 3: the actual tests
cd apps/web/platform
pnpm test:e2e           # full suite
pnpm test:e2e:ui        # Playwright UI mode (recommended for dev)
pnpm test:e2e:headed    # visible browser
pnpm exec playwright test e2e/specs/weldcrm/companies-crud.spec.ts  # one file
```

The `webServer` block in `playwright.config.ts` starts `pnpm dev` automatically when no server is on `:3000`, so the Terminal 1 step is optional, `pnpm test:e2e` works standalone.

### In CI

`pr-checks.yml` runs the suite on every PR against `main` or `develop`, plus every push to `develop`. The job uses the three secrets above; if any are unset, the seed-driven specs `test.skip()` themselves with a clear message and the rest of the suite still runs.

`deploy.yml` runs the same suite as part of the `tests` job that gates production deploys. Worker deploys and migrations both `needs: tests`, so a red Playwright run blocks the deploy.

## What the suite covers

| Group | Files | Description |
|---|---:|---|
| `specs/smoke/` | 15 | Every authenticated URL the platform serves (219 routes) loads, sidebar renders, no console errors. |
| `specs/<module>/*.spec.ts` | 21 | Per-module interaction specs: sub-page loads, action buttons trigger navigation, primary CTAs visible. |
| `specs/<module>/<entity>-crud.spec.ts` | 7 | Seed → assert → reset CRUD specs for companies, people, leads, lists, pipelines, projects, tasks. |
| `specs/<module>/*-form.spec.ts` | 4 | Form field contracts (stable `id="..."` selectors pinned) for announcements, news, customers, settings/business. |
| `specs/navigation.spec.ts`, `header-toggles.spec.ts`, `drawers.spec.ts`, `breadcrumbs.spec.ts`, `command-palette.spec.ts`, `redirects.spec.ts` | 6 | Cross-cutting interactions: sidebar nav, notifications drawer, calendar/agent toggles, cmdk, legacy URL backwards-compat. |
| `specs/unauth/*` | 2 | Runs in the `chromium-unauth` Playwright project (no saved Clerk session); covers `/auth/*` pages + the full new-user signup → onboarding wizard → workspace provisioning → dashboard flow (`onboarding.spec.ts`). |

The auto-applied `consoleErrors` fixture (`e2e/fixtures.ts`) fails any spec that emits an unexpected `console.error` or `pageerror`, so the smoke suite alone catches a huge class of regressions.

## Page objects

- `AppShellPage`, sidebar entries by `data-testid="app-nav-<key>"`.
- `EntityGridPage`, the shared `<EntityGrid />` wrapper: `root()`, `createButton()`, `searchInput()`, `rows()`, `rowById(id)`, `waitForReady()`, `search(term)`.

## `data-testid` conventions

Every shared surface that specs need to target has a stable `data-testid`:

```
app-sidebar                            → the fixed left rail
app-nav-<key>                          → each sidebar entry
                                         (home, commerce, crm, projects, helpdesk,
                                          mail, task, host, appstore)

entity-grid                            → root of <EntityGrid />
entity-grid-create-btn                 → primary New <entity> button
entity-grid-search                     → search input
entity-grid-row                        → each body row (also data-entity-id)

notifications-bell                     → header notifications toggle
notifications-panel                    → the slide-in panel root
notifications-unread-badge             → red dot when unread

calendar-toggle                        → header calendar toggle
calendar-today-badge                   → red dot when events today
calendar-drawer                        → the slide-in calendar drawer root

weldagent-toggle                       → header WeldAgent toggle
weldagent-drawer                       → the lazy-loaded WeldAgent panel root

tickets-create-btn                     → welddesk tickets list "+" button
welddrive-new-folder-btn               → welddrive "New Folder" button
settings-roles-create-btn              → settings/roles "Create Role" button

cmdk-input                             → global search input

page-header-action-<slug>              → every EntityPageHeader ActionButton
                                         (slug from explicit testId: prop,                                           locale-stable, NOT derived from label)
```

If you add a new primary CTA to a page that ships with E2E coverage, give it a `data-testid`, keeps the spec's selector stable across translations + Tailwind class drift.
