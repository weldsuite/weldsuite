# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor and others) working
in this repository. Folders with their own rules have their own `AGENTS.md`;
read it before changing code there:

| Folder | Covers |
|---|---|
| [`apps/web/platform/AGENTS.md`](apps/web/platform/AGENTS.md) | The platform SPA: routing, auth facade, API client, UI library, E2E |
| [`apps/mobile/AGENTS.md`](apps/mobile/AGENTS.md) | The Expo apps and the Global/EU/self-hosted server choice |
| [`apps/workers/pass-api/AGENTS.md`](apps/workers/pass-api/AGENTS.md) | WeldPass: secret vaults and the password manager |
| [`packages/sdk/AGENTS.md`](packages/sdk/AGENTS.md) | WeldApps and the published SDKs, whose protocols change in lockstep |
| [`rust/AGENTS.md`](rust/AGENTS.md) | The Rust backend for the EU and self-hosted editions |

## What this is

WeldSuite is a multi-tenant business platform (CRM, helpdesk, mail, projects,
accounting, commerce, chat, meetings, AI agents and more) built as `weld*`
modules a workspace installs. It is a pnpm 10.34.5 + Turborepo monorepo on
Node 22+.

Today it ships as three editions from one codebase (ADR OPS-012). Global is
being retired: once its workspaces have moved into the EU install, two remain,
hosted EU and self-hosted (ADR OPS-025, which supersedes OPS-012).

- **Global** (being retired): the platform SPA (Vite + React 19, TanStack
  Router, Clerk) talks to Hono APIs on Cloudflare Workers, backed by Neon
  Postgres through Drizzle.
- **EU** and **self-hosted**: the same frontends against a Rust backend
  (`rust/`) on Kubernetes, with Zitadel (OIDC) sign-in. Only the modules in
  `RUST_PORTED_MODULES` (`packages/core/api-modules`) are offered there; the
  platform hides the rest (`apps/web/platform/lib/edition.ts`).

### Design docs and ADRs

How WeldSuite is built, and why, lives in the private repo
[`weldsuite/weldsuite-documentation`](https://github.com/weldsuite/weldsuite-documentation),
cloned next to this one (`../weldsuite-documentation`): a design doc per
platform area and per module, and ADRs numbered per area (`API-003`,
`DATA-004`, …). Start at `design/platform/overview.md`. Read the area's design
doc and ADRs before changing how an area works, and treat an *Accepted* ADR as
a rule. The `weldsuite-docs` skill finds, reads and updates them.

**This repository is public. Never commit plans, design notes, ADRs,
investigation write-ups, digests or any other internal documentation here**:
they go to `weldsuite-documentation`. That includes `docs/` and `.claude/` in
this repo. Plans live in that repo's `plans/` folder (the ones this repo used
to keep in `docs/` moved there); a comment that names
`weldsuite-documentation/plans/<file>.md` points at one. What belongs here is
code, READMEs that explain how to use or run the code, and the agent setup
(`AGENTS.md`, `.claude/agents`, commands, skills).

## Modules

The module list's source of truth is `PERMISSION_APPS` in
`packages/core/permissions/src/apps.ts` (app codes) and `API_MODULES` in
`packages/core/api-modules/src/index.ts` (which worker serves which paths).
Screens live in `apps/web/platform/app/<app code>/`.

| Module | What it is | API worker |
|---|---|---|
| Core platform | Workspaces, members, roles, settings, WeldDrive files, search, billing, credits, notifications, App Store, custom objects (WeldObjects) | `app-api` |
| WeldCRM | Companies, people, leads, opportunities, pipelines, activities, quotes | `crm-api` |
| WeldDesk | Helpdesk tickets, conversations, SLAs, widget, help center | `desk-api` |
| WeldKnow | Knowledge spaces and pages | `know-api` |
| WeldMail | Email client, accounts, rules, campaigns | `mail-api` |
| WeldReach | Cold outreach campaigns and mailbox warm-up (staff-approved) | `reach-api` |
| WeldChat | Team chat | `chat-api` |
| WeldMeet | Video meetings | `meet-api` |
| WeldCalendar | Calendars, events, booking pages | `calendar-api` |
| WeldCall | Telephony | `call-api` |
| WeldFlow | Projects and personal tasks | `flow-api` |
| WeldBoard | Whiteboards (WeldFlow's whiteboards moved here) | `board-api` |
| WeldDocs | Word processing with live co-editing | `docs-api` |
| WeldSheets | Spreadsheets with live co-editing | `sheets-api` |
| WeldForms | Forms and surveys | `forms-api` |
| WeldSign | Electronic signatures | `sign-api` |
| WeldCommerce | Being rebuilt from scratch (see below), EU edition only; phase 0 serves the overview | `rust/modules/commerce` (Rust only, no TypeScript worker) |
| WeldStash | Warehouse management, and the product catalogue (`/api/products`) until WeldCommerce is back | `stash-api` |
| WeldBooks | Double-entry accounting, per-country tax | `books-api` |
| WeldHR | HR and payroll (NL, US) | `hr-api` |
| WeldHost | Domains and DNS | `host-api` |
| WeldSocial | Social publishing | `social-api` |
| WeldAds | Ad campaigns | `ads-api` |
| WeldData | Lead database and enrichment | `data-api` |
| WeldPanel | Product and web analytics, session recordings | `panel-api` (+ public collector `panel-ingest`) |
| WeldMerge | Pull requests and issues across Git providers | `merge-api` |
| WeldPass | Secret vaults and team password manager | `pass-api` |
| WeldConnect | Workflow automation | `connect-api` (+ engine `workflow-worker`) |
| WeldAgent | Workspace AI agents | `agent-api` |
| WeldApps | Apps users build, hosted in a sandboxed iframe | `app-api`, `external-api` |

Old module names (`task`, `accounting`, `wms`, …) still appear in places;
`normalizeAppCode` in `@weldsuite/permissions` maps them.

**WeldCommerce is being rebuilt from scratch.** Its code was removed on
2026-11-20: the `commerce-api` worker and the Rust `commerce` module, the
platform pages, the B2B order portal, all shipping (Sendcloud, PrintNode,
parcels, returns, the parcel portals), and the public API and MCP commerce
surface. The tenant tables (`products`, `orders`, `categories`, `parcels`, …)
stay. `/api/products` is served by `stash-api` (and the Rust stash module) in
the meantime, and WeldStash ships pick lists without a carrier. The rebuild is
for the EU edition only: build it in `rust/modules/commerce`, not as a new
TypeScript worker.

## Repository map

**`apps/web/`**, browser frontends (dev port in brackets):
- `platform` (3000): the main SPA. Every module's UI lives here.
- TanStack Start on Cloudflare Workers: `admin` (3001, staff console, also a
  Node build for Kubernetes), `helpcenter` (3008), `sign-portal` (3023),
  `project-portal` (3024), `forms-portal` (3025).
- Next.js: `sites` (3007, customer websites), `api-docs` (3009), `docs` (3010,
  help.weldsuite.org), `booking-portal` (3019), `meeting-portal` (3020).
- Vite SPAs: `developer` (WeldApps developer portal), `partner` (3203,
  reseller portal), `weldmail` and `weldcalendar` (consumer apps on a personal
  Weld account, served by `personal-api`), `helpdesk-widget` (3100).
- `weldpass-extension`: WeldPass browser extension, built and loaded by hand.

**`apps/workers/`**, Cloudflare Workers (Hono):
- `app-api` (8789): the core API. It also forwards every module path to that
  module's worker, so clients that still call it keep working.
- `<module>-api`: one per module, as in the table above; dev ports are in
  `API_MODULES`.
- Other public entry points: `external-api` (api.weldsuite.org, `wsk_` keys),
  `mcp-server`, `personal-api` (consumer WeldMail/WeldCalendar accounts),
  `helpdesk-widget-api`, `panel-ingest`.
- Background workers: `entity-events-worker` (event hub), `realtime-worker`
  (Durable Objects + WebSocket), `workflow-worker`, `helpdesk-workflow-worker`,
  `mail-inbound-worker`, `analytics-worker`, `audit-log-worker`,
  `integration-webhook-worker`, `integration-sync-worker`, `billing-worker`
  (Stripe), `workspace-worker` (provisioning), `reach-warmup-worker`,
  `agent-runtime` (internal, called by `agent-api` and `chat-api`),
  `discord-bot-worker`, `test-email-worker`.

**`apps/mobile/`**: one Expo app per module, plus `_template` and `_shared`.
**`apps/desktop/`**: Electron shell around the platform.
**`apps/tools/`**: `migrate-databases` (Global's tenant migration runner,
no longer run by its deploy since ADR DATA-019),
`storybook`, `test-dashboard`, `collab-rooms` (the Docs/Sheets/Board rooms on
Node for Kubernetes), `outbound-audit`, `discord-bot`.
**`apps/hosted-apps/`**: first-party WeldApps, deployed with `weld app deploy`,
never compiled into the platform (see its README).
**`rust/`**: the Rust backend (EU and self-hosted), the schema
(`rust/crates/schema`) and the master and tenant migrations (`rust/migrations`).

**`packages/`**, all scoped `@weldsuite/*` and always imported by package name,
never by path:
- `config/`: eslint and TypeScript configs.
- `core/`: platform primitives: `db` (the Drizzle schema, frozen since the
  schema moved to Rust, and the personal database's migrations),
  `worker-kit` (what every API worker is built on), `api-modules`,
  `permissions`, `entity-events`, `feature-flags`, `i18n`, `ai`, `credits`,
  `notifications`, `emails` (system email templates), `realtime`, `collab` and
  the docs, sheets, board and forms engines, the `cloudflare-*` wrappers, and
  clients for outside services.
- `domains/`: module code more than one worker needs (`@weldsuite/crm-domain`,
  `@weldsuite/agent-domain`, …). `core-domain` holds cross-module pieces such
  as AI billing.
- `clients/`: `app-api-client` (typed client and the shared Zod schemas),
  `api-client` (the HTTP transport), `core-api-client` (still load-bearing
  Zod schemas despite its name), `personal-api-client`, `mobile-platform`.
- `design/`: `ui` (the shared component library), `mobile-ui`,
  `site-components`, `weldmeet-ui`, `forms-renderer`.
- `sdk/`: published, permissively licensed SDKs: `app-sdk`, `cli`,
  `helpdesk-widget-sdk`, `forms-embed`, `panel-sdk`, `cursor-plugin`.

## Commands

```bash
pnpm install                 # after every pull
pnpm dev                     # everything, through turbo
pnpm dev:api                 # app-api + every module worker in one wrangler dev (port 8789)
pnpm build                   # also: pnpm lint, pnpm format
pnpm storybook               # component playground
pnpm create:module-api <m>   # scaffold a module worker
pnpm create:mobile-app       # scaffold a mobile app from _template
pnpm api:ownership           # what still sits in app-api
```

Per workspace, use `pnpm --filter <name> <script>`; app names are the folder
names (`platform`, `app-api`, `crm-api`, …):

```bash
pnpm --filter platform test            # also dev, build, lint, type-check
pnpm --filter app-api test             # integration tests on in-memory Postgres (pglite), no services needed
pnpm --filter <module>-api dev         # one module on its own port; set VITE_API_MODULES=<module> in the platform's .env.local
NODE_OPTIONS=--max-old-space-size=12288 pnpm --filter platform type-check   # runs out of memory on the default heap
```

Database (schema in `rust/crates/schema`, migrations in `rust/migrations`,
applied by `weldsuite migrate`; ADR DATA-019):

```bash
pnpm db:generate --name <slug>                     # tenant migration from the entities
pnpm db:generate:master --name <slug>              # master migration
pnpm db:generate --name <slug> --custom            # empty migration for hand-written SQL
pnpm --filter @weldsuite/db db:generate:personal   # personal-account migration (still Drizzle)
```

Workers: `wrangler.toml` has an `[env.test]` and an `[env.production]`; the
top-level config is for `wrangler dev` only and is named `<worker>-dev`. Always
pass `--env test` or `--env production` to `wrangler deploy`, `secret put` or
`tail` (`packages/core/api-modules/src/wrangler-config.test.ts` enforces this).
Worker secrets are listed per worker in `scripts/secrets/manifest.ts`.

Rust: `pnpm rust:lint`, `pnpm rust:test`, `pnpm rust:catalogs`,
`pnpm rust:conformance`; see `rust/AGENTS.md`.

## Rules for every change

### Where code goes

- **A module's endpoints go in its worker** (`apps/workers/<module>-api`), core
  platform endpoints in `app-api`. Routes are organised by object (customers,
  tickets, …), and one endpoint backs every surface: platform, mobile, MCP.
- End to end: shared Zod schema in `@weldsuite/app-api-client` → service in
  `src/services/<entity>.ts` (pure functions, no Hono context) → route in
  `src/routes/<entity>/index.ts`, mounted in the worker's `src/index.ts` →
  client in `@weldsuite/app-api-client` → hook in
  `apps/web/platform/hooks/queries/use-<entity>-queries.ts`.
- **A new path prefix is registered** for its module in
  `packages/core/api-modules/src/index.ts`, or the ownership test fails.
- **Workers never import from another worker's folder.** Share code through
  `packages/domains/<module>` or `@weldsuite/worker-kit`.
- Workers are built on `@weldsuite/worker-kit`: `createModuleApi`, `apiAuth()`
  (session → workspace → tenant DB → feature flags), `success()`, `list()`,
  `error.*`, `generateId()`, the pglite test harness. Responses are
  `{ data }`, `{ data, pagination: { totalCount, hasMore, cursor } }`,
  `{ error: { code, message, details? } }`, or 204 for a delete.
- **Every route checks a permission** with `requirePermission()` from
  `@weldsuite/permissions`.
- **Every mutation publishes an entity event** with `publishEntityEvent()`
  from `@weldsuite/entity-events`, after the write succeeds and before
  returning. It feeds audit, analytics, search, webhooks, workflows, agents and
  realtime. Entity types and actions are typed from
  `packages/core/entity-events/src/events/`. WeldPass is the one exception.

### Data

- **Three kinds of database**: a master DB (workspaces, users, billing,
  registries), one tenant DB per workspace (its business data) and a shared
  personal DB for consumer accounts. The master and tenant schemas are the
  SeaORM entities in `rust/crates/schema/src/{master,tenant}/`, one per table
  with its DDL (ADR DATA-019). The Drizzle schema in
  `packages/core/db/src/schema/` is frozen: the TypeScript workers still read
  it, but schema changes go into the entities. The personal schema is still
  Drizzle's.
- **Scope every tenant query by `workspaceId`.**
- `workspaces.id` (`ws_…`) identifies a workspace everywhere; the Clerk org id
  (`org_…`) is only for Clerk calls and stores still keyed by it. Store
  `workspaces.id` in anything new, and match a value that may be either with
  `matchWorkspaceRef` (`@weldsuite/db/lib/workspace-ref`), never by prefix
  (ADR SEC-011).
- Ids are `varchar(30)` from `generateId('<prefix>')`; JSONB columns are typed
  with `.$type<T>()`.
- **Changing the entities is fine. Creating a migration is not, until the user
  approves it.** Then generate it with `pnpm db:generate --name <slug>` (or
  `db:generate:master`; `db:generate:personal` for the personal schema) and
  commit the SQL, its `meta/<n>_snapshot.json`, the `_journal.json` entry and
  the pruned old snapshots together. Never hand-write a migration or a journal
  entry. CI fails when the entities and the newest snapshot disagree, or a
  `.sql` file isn't journaled (`rust/crates/schema/tests/snapshot.rs`).
- **Keep migrations additive.** EU production deploys every green `main` build
  automatically, so code and schema must work one version apart. The generator
  refuses a drop, a type change or `SET NOT NULL` without `--allow-drop`, and
  never guesses a rename.

### Never wake tenant databases on a timer

Each tenant DB is a Neon compute that suspends when idle. No cron, scheduled
Workflow, polling loop or queue job may iterate workspaces and connect to each
tenant to check whether anything is due: with hundreds of workspaces that wakes
every compute on every tick. Keep the timing in an always-on store and open a
tenant only when it has work:

- **D1 indexes** in the schedule-index database (`SCHEDULE_INDEX` binding,
  migrations in `apps/workers/workflow-worker/migrations/d1/`): WeldConnect
  schedules in `schedule_index` (`connect-api/src/lib/schedule-index.ts`, swept
  by `workflow-worker`), WeldAgent routines in `weldagent_routine_index`
  (`packages/domains/agent/src/routine-index.ts`, swept by
  `agent-api/src/cron/weldagent-routines.ts`). Write the row on every create,
  update, pause and delete.
- **Per-workspace "next due" sweeps** use `workspace_due_index` through
  `@weldsuite/worker-kit/due-index` (`runDueIndexSweep`, `markWorkspaceDue`,
  `syncWorkspaceDue`). A new sweep of that shape adds a kind there
  (today: `mail_snooze`, `calendar_replan`, `domain_renew`), not a new table.
- **The master DB**, when the data already lives there.
- **Event-driven work** only touches the tenant that produced the event,
  which is fine.

If a D1 read fails, skip the tick and log it; never fall back to a tenant
fan-out. A one-time backfill guarded by a KV flag is fine when introducing a
new index. In the browser, polls that are mounted everywhere (badges, unread
counts) use `useIdleAwareRefetchInterval`
(`apps/web/platform/hooks/use-user-idle.ts`) so they stop when nobody is there.

### Both backends

**Global is being retired, so build in Rust first (ADR OPS-025).** Global's
workspaces move into the EU install, and the TypeScript workers are deleted
after the cutover (plan: `weldsuite-documentation/plans/retire-global-edition.md`).
Until then:

- New features are built in Rust.
- The TypeScript workers get only fixes, plus whatever a shared frontend change
  needs to keep working on Global.
- A feature that exists only in Rust gets an `EditionFeature`
  (`apps/web/platform/lib/edition.ts`) and goes into
  `GLOBAL_UNAVAILABLE_FEATURES` (`packages/core/api-modules`). That hides it on
  Global in the platform and in the mobile apps.

A route listed in `rust/conformance/suites.json` is served by the TypeScript
worker and by Rust: change its behaviour in both, and `pnpm rust:conformance`
checks they still answer alike. After changing entity events, permissions,
feature flags, `api-modules` or `FIRST_PARTY_ORIGINS`, run
`pnpm rust:catalogs` and commit the `rust/` changes; Lint fails when the export
is stale.

### AI

- All LLM calls go through `@weldsuite/ai` (Vercel AI SDK via the Cloudflare
  AI Gateway). No direct provider SDK calls. A worker that uses it needs
  `CF_ACCOUNT_ID` and `AI_GATEWAY_API_TOKEN` (or `CLOUDFLARE_API_TOKEN`).
- Usage is charged to the workspace credit wallet with `chargeAiUsage` from
  `@weldsuite/core-domain/ai-billing`. A failing third-party model falls back
  to `AI_FALLBACK_MODEL`, so **charge the model that served**:
  `chargeAiUsage({ modelId: billedModelId(requestedId, result) })`.
- The exception is WeldAgent's workspace agents, which run on Claude Managed
  Agents through `@anthropic-ai/sdk` in `packages/domains/agent` (design doc
  `design/modules/weldagent.md`).
- The EU edition has no AI yet; it is moving to Mistral, with a workspace
  opt-in to non-EU providers (ADR AI-012, design doc
  `design/platform/ai-platform.md`).

### Outside services

- **Cloudflare REST goes through the official `cloudflare` SDK**, imported
  from `cloudflare/tree-shakable` with `createClient({ resources: [...] })`,
  never `new Cloudflare()` (it bundles the whole API). Add a resource to the
  matching `@weldsuite/cloudflare-*` package rather than hand-rolling
  `api.cloudflare.com` calls.
- System emails are React Email templates in `@weldsuite/emails`, sent through
  Cloudflare Email Service (skill `weldsuite-email`).

### UI and text

- UI comes from `@weldsuite/ui` (`packages/design/ui`), imported by path:
  `@weldsuite/ui/components/<name>`. Every component has a story in
  `apps/tools/storybook`. **Missing or not quite right? Change the library**
  (component plus story), never a copy in a module folder. Library components
  hold no translations: labels come from `UiLabelsProvider` or props.
- **Every new user-visible string needs an entry in `en` and `nl`**, in
  `packages/core/i18n/src/locales/<locale>/*.ts` (TypeScript modules, not
  JSON). `es`, `fr` and `pt` are partial. A wrong key path fails at runtime,
  not at compile time (`t.common.actions.cancel`, not `t.common.cancel`).
- Zod v3 only in app code, even though the root overrides mention v4.
  Tailwind v4. Server state in TanStack Query, client state in Jotai, forms in
  React Hook Form with the Zod resolver.
- Help docs (`apps/web/docs`) use Playwright screenshots of the real UI. When
  you change a documented screen, update the copy and regenerate them in the
  same change: `pnpm --filter docs capture-screenshots:all` (skill
  `help-docs`).
- **An app's settings live only in Settings → Apps**
  (`/settings/apps/{appCode}`, listed in the Settings side nav): never inside
  the app, never in the app's own sidebar, and no redirects from old paths.
  See "App settings live in Settings, nowhere else" in
  [`apps/web/platform/AGENTS.md`](apps/web/platform/AGENTS.md).

### Modern web guidance

Web frontend code is checked against Modern Web Guidance, the Chrome team's
skill in `.agents/skills/modern-web-guidance` and
`.claude/skills/modern-web-guidance`. Do it on your own, before you write the
code: the user doesn't have to ask for it, and you don't ask whether to.

- **When:** any change to HTML, CSS or browser-side JavaScript/TypeScript in a
  web frontend: the platform, `@weldsuite/ui`, the portals and sites, admin,
  partner, developer, docs, the helpdesk widget, the WeldPass extension and
  the hosted WeldApps. Not for backend, workers, Rust, SQL, CI, scripts,
  test-only, config, copy or translation changes, or the Expo apps (React
  Native has no DOM).
- **Search** once per UI pattern or platform capability, with a 2–5 word
  generic English query and no framework, product or module names:
  `npx -y modern-web-guidance@latest search "light dismiss dialog"`
  (`npx.cmd` in PowerShell).
- **Retrieve** the guides that match:
  `npx -y modern-web-guidance@latest retrieve "<id>,<id>"`. A large result is
  saved to a temp file; read all of it.
- **Apply it through our stack.** The guides are vanilla HTML/CSS/JS, and the
  repo rules win where they differ: a pattern that belongs in a dialog,
  popover, select or other shared component goes into `@weldsuite/ui` with its
  story, not into a module; Tailwind v4; React 19.
- **Check** the change against the guides before finishing, and end the reply
  that delivers it with the `### Modern Web Guidance` section the skill
  describes (or one sentence on what you searched and why nothing applied).
- **Browser support** is Baseline Widely available, the skill's default and
  Vite's build target, so there is no `.mwgrc`: newer features get the
  guide's fallback. Don't run `set-baseline`, `set-allow-origin-trials` or
  `set-allow-volatile-features` and don't edit `.mwgrc`; ask the user.
- `legacy-scan` is only for a codebase-wide modernization audit someone asked
  for.
- The repo keeps only `SKILL.md`, the same plain file in both folders (no
  link); the guides come from npm at run time. When the CLI says a newer
  `SKILL.md` exists, copy it into both folders and update `skills-lock.json`.

### Kept in lockstep

Change both sides in the same PR:

- `packages/sdk/helpdesk-widget-sdk/src/core/IframeManager.ts` and
  `apps/web/helpdesk-widget/test-local.html`.
- `packages/sdk/forms-embed` (`src/protocol.ts`, `src/auto.ts`), the
  forms-portal embed view and
  `apps/web/platform/app/weldforms/share/embed-snippet.ts`.
- The WeldApps bridge: `@weldsuite/app-sdk`, the platform host page and the
  CLI's local shell; the `weldapp.json` schema and its copy in the CLI (see
  `packages/sdk/AGENTS.md`).

## CI and deploys

- **One branch: `main`.** Every PR targets `main`. Required checks: `Lint`,
  `Build`, `Type Check · app-api`, `Type Check · platform`, `Unit · app-api`,
  `Unit · platform`, `Rust` and `WeldSuite Review`. CI job names are required
  status checks; don't rename them. On a PR, jobs run only for the areas the
  change touches (`.github/scripts/ci-changes.mjs`).
- **Test** deploys every `main` commit that passes CI: `handoff.yml` starts
  `deploy-test` in the private repo `weldsuite/weldsuite-deploy`
  (`*-test.weldsuite.org`, `app-test.weldsuite.org`).
- **Global production** goes out only through the Promote workflow in
  `weldsuite-deploy`, run by a person, for a commit test already runs.
  **EU production** follows the EU test cluster automatically
  (`eu-production-watch.yml`). Self-hosted installs get tagged releases.
- The deploy logic stays in this repo: `.github/actions/deploy-*` and
  `.github/scripts/deploy-plan.mjs`. A new worker, mobile app, Pages app,
  Vercel app or TanStack Start app is added there, never to a workflow.
- Test Pages projects and Vercel test builds still carry the label `develop`.
  That is a project setting, not a branch; leave it.

## Working on a task

WeldSuite itself is the task tracker, through the WeldSuite MCP server
(`get_task`, `search_tasks`, `update_task`, `create_task`,
`create_task_comment`, `search_tickets`, …; match the tools by name suffix).

- **`/weldtask <number>`** takes one task from the tracker to a PR: resolve,
  interview as needed, branch `weldtask/task-<n>-<slug>` from `origin/main`,
  triage, implement through the specialist agents, Definition of Done, PR,
  task comment and status `review`.
- Other commands in `.claude/commands/`: `/fix-bug`, `/feature`, `/fix-issue`
  (GitHub issues), `/enrich`, `/enrich-issue`, `/claim`, `/done`,
  `/list-bugs`, `/queue`, `/autopilot`.
- Specialist agents in `.claude/agents/`: stack (`frontend-platform`,
  `backend-app-api`, `backend-workers`, `database`, `mobile-expo`, …), domain
  (`weldcrm`, `welddesk-helpdesk`, `weldbooks-accounting`, …) and country
  accounting (`accounting-nl`, `-be`, `-de`, …).
- Commit as `fix(<module>): …` or `feat(<module>): …`, ending with
  `(TASK-<n>)` when there is a task.

### Definition of Done

- A bug reproduced before the fix and doesn't after. Don't "fix" what you
  couldn't reproduce; ask for more information.
- `lint`, `type-check`, `test` and `build` pass in every workspace you
  touched. Add a test that fails before a fix and passes after where the
  workspace has tests. Errors that already exist on `main` in files you didn't
  touch: mention them, don't fix them.
- Every touched query is scoped by `workspaceId`; every new or changed route
  checks a permission and validates input and output with Zod; every new
  mutation publishes an entity event.
- New strings in `en` and `nl`.
- Web frontend changes were checked against Modern Web Guidance (see "Modern
  web guidance").
- No stray `console.log`, `any` or `@ts-ignore`.
- Schema changes are called out; no migration without approval.
- A decision made, reversed or replaced has its ADR and design doc updated in
  `weldsuite-documentation`, with the docs PR linked from the code PR.

### Never

- Commit a plan, design note or other internal document (see "Design docs and
  ADRs").
- Edit `apps/web/platform/src/routeTree.gen.ts` (generated).
- Write a migration without the user's approval.
- Bypass `/autopilot`'s four hard stops (interview, can't reproduce,
  migration, PR open).
- Overwrite a task's original description: enrichment is appended below `---`.
- Look for `apps/core-api`, `apps/api-worker`, `apps/mobile-api-worker` or
  the old AI workers (`agent-worker`, `agent-service`, `ai-worker`): they were
  deleted.
