# AGENTS.md

The authoritative map of this monorepo (modules, routing, API/DB conventions,
commands) lives in [CLAUDE.md](./CLAUDE.md) and [CONTRIBUTING.md](./CONTRIBUTING.md).
Read those first. This file adds one hard architecture rule plus
cloud-environment caveats.

## Never periodically wake tenant databases

Every workspace has its own Neon Postgres (tenant DB), which suspends when
idle. **No service may open tenant DBs on a timer** — no cron, scheduled
Workflow, polling loop or queue job that iterates workspaces and connects to
each tenant "to check if anything is due". With hundreds of workspaces that
wakes every compute every tick, costing money and cold starts for nothing.

Instead, keep the *timing* in an always-on store and open a tenant only when
it has real work:

- **D1 index** (preferred for schedules): the schedule-index D1 database
  (`SCHEDULE_INDEX` binding). WeldConnect schedules use `schedule_index`
  (`app-api/src/lib/schedule-index.ts` → `workflow-worker` sweep); WeldAgent
  routines use `weldagent_routine_index`
  (`app-api/src/lib/weldagent-routine-index.ts` → `app-api/src/cron/weldagent-routines.ts`).
  Write the row on every create / update / pause / delete and re-derive it
  from the tenant when the tenant is open anyway; the sweep reads only D1.
  Migrations live in `apps/workers/workflow-worker/migrations/d1/` and
  `deploy.yml` applies them.
- **Master DB** (single always-on Neon), when the data already lives there,
  e.g. the digest sweep filters on master `digest_schedules` first.
- **Event-driven** work (entity-event queues, Workflows started by a request)
  only touches the tenant that produced the event, which is fine.

If a D1 read fails, skip the tick and log it — never fall back to a tenant
fan-out. A one-time backfill that opens every tenant (guarded by a KV flag,
like `weldagent:routine-index:backfill:v1`) is acceptable when introducing a
new index.

Known offenders still to migrate: `app-api/src/cron/calendar-replan.ts` and
`app-api/src/cron/domain-auto-renew.ts` open every active tenant daily.

## Cursor Cloud specific instructions

Toolchain is already provisioned (Node 22, pnpm 10.34.5). The startup update
script runs `pnpm install`; you normally don't need to reinstall.

### Branches
Daily work goes to **`develop`** and deploys to test (`app-test.weldsuite.org`). Merge `develop` → **`main`** to deploy production (`app.weldsuite.org`).

The hosted product depends on Clerk, Neon, Cloudflare, and Stripe. Local UI needs `VITE_CLERK_PUBLISHABLE_KEY`; a logged-in flow also needs a provisioned workspace.

### Best offline verification path (no external services)
The backend has a full in-memory Postgres (`@electric-sql/pglite`) test harness.
This is the strongest way to exercise real route → service → Drizzle → schema
logic locally:

- `pnpm --filter app-api test`  — ~684 integration/unit tests, all offline.
- `pnpm --filter platform test` — component/unit tests (Vitest + jsdom).

### Running the backend worker locally
Plain `pnpm dev` (i.e. `wrangler dev`) **fails** with "You must be logged in to
use wrangler dev in remote mode" because `wrangler.toml` marks the `FLAGSHIP`,
`REALTIME`, and `WORKSPACE_WORKER` bindings `remote = true`. Run fully local
instead (those three bindings become unavailable, which is fine for most work):

```
cd apps/workers/app-api && pnpm exec wrangler dev --port 8789 --local
```

Sanity checks once it's up: `GET /robots.txt` → 200, `GET /health` → 503 with a
"no database connection string" message (expected without Neon), `GET /api/*` →
401 without a Clerk JWT (auth guard working).

### Platform type-check needs a bigger heap
`pnpm --filter platform type-check` (`tsc --noEmit`) OOMs at Node's default heap.
Run it with more memory:

```
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter platform type-check
```

`pnpm --filter platform build` (Vite) does **not** need this and passes on its
own. Note: the platform type-check currently surfaces some pre-existing TS
errors unrelated to environment setup.

### Lint
Most quality gating for `platform`/`app-api` is `type-check` + tests (they have
no `lint` script). Packages that do define real ESLint (e.g. `@weldsuite/db`,
`@weldsuite/ui`) run via `pnpm --filter <name> lint`. `pnpm lint` at the root
fans out through Turborepo.

### Default dev ports
platform 3000, app-api 8789, realtime-worker 8790, billing-worker 8788.

### Help docs (`help.weldsuite.org`) + UI screenshots

Product help lives in `apps/web/docs`. Guide images are **Playwright screenshots** of real
platform UI via `/preview/help-docs?scene=…` — not hand-drawn assets.

**When you change WeldHost UI (or any screen documented in help), you must in the same
change:**

1. Update Markdoc copy in `apps/web/docs/src/app/` if labels/steps changed
2. Adjust preview scenes/fixtures in `apps/web/platform/app/preview/help-docs/` if needed
3. Regenerate PNGs: `pnpm --filter docs capture-screenshots:all`
4. Commit the updated `apps/web/docs/public/images/help/*.png` with the UI change

Full workflow: [.agents/skills/help-docs/SKILL.md](./.agents/skills/help-docs/SKILL.md)

Do **not** leave docs on stale screenshots. Do **not** use CI to auto-commit images —
agents and developers regenerate locally as part of the UI task.

### Automating the login form in tests
The platform sign-in page (`/auth/login`) is a custom form (fields `#email` /
`#password`) backed by `react-hook-form`, not Clerk's drop-in `<SignIn>`.
Programmatic `page.fill()` / synthetic key injection does **not** update RHF
state, so the submit sends an empty identifier and Clerk returns
"Identifier is invalid". Use realistic per-character typing instead
(Playwright: `locator.pressSequentially(value, { delay })`). With a valid
account this reaches `POST <fapi>/v1/client/sign_ins` → `status: complete` and
redirects to `/`, after which authenticated `app-api` calls (e.g.
`/api/workspaces`, `/api/companies`) return 200/201 against the real tenant DB.
