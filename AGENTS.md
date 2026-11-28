# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor and others) working
in this repository. Folders with their own rules have their own `AGENTS.md`;
read it before changing code there:

| Folder | Covers |
|---|---|
| [`apps/web/platform/AGENTS.md`](apps/web/platform/AGENTS.md) | The platform SPA: routing, auth facade, API client, UI library, E2E |
| [`apps/mobile/AGENTS.md`](apps/mobile/AGENTS.md) | The Expo apps and the Global/EU/self-hosted server choice |
| [`apps/ios/AGENTS.md`](apps/ios/AGENTS.md) | The native iOS apps (Swift, SwiftUI) replacing the Expo apps |
| [`apps/android/AGENTS.md`](apps/android/AGENTS.md) | The native Android apps (Kotlin, Compose) replacing the Expo apps |
| [`packages/sdk/AGENTS.md`](packages/sdk/AGENTS.md) | WeldApps and the published SDKs, whose protocols change in lockstep |
| [`rust/AGENTS.md`](rust/AGENTS.md) | The Rust backend, the only backend |
| [`rust/modules/pass/AGENTS.md`](rust/modules/pass/AGENTS.md) | WeldPass: secret vaults and the password manager |

## What this is

WeldSuite is a multi-tenant business platform (CRM, helpdesk, mail, projects,
accounting, commerce, chat, meetings, AI agents and more) built as `weld*`
modules a workspace installs. It is a pnpm 10.34.5 + Turborepo monorepo on
Node 22+.

It ships as two deployments of one backend (ADR OPS-025): **hosted**, the
EU install on `weldsuite.eu`, and **self-hosted**. Both run the Rust backend
(`rust/`) on Kubernetes behind the same frontends: the platform SPA (Vite +
React 19, TanStack Router), the portals, and the mobile and desktop apps.
Sign-in is OIDC (WeldID or Zitadel).

The Global edition (TypeScript Hono workers on Cloudflare, Clerk, Neon) is
retired. Its workspaces moved into the EU install on 2026-11-27, and its
TypeScript backend was deleted from this repo afterwards. Its `*.weldsuite.org`
hosts still answer, as aliases of the EU install.

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
`packages/core/permissions/src/apps.ts` (app codes) and
`rust/catalogs/api-modules.json` (which module owns which API paths).
Screens live in `apps/web/platform/app/<app code>/`, routes in
`rust/modules/<module>/`.

| Module | What it is | Rust module |
|---|---|---|
| Core platform | Workspaces, members, roles, settings, WeldDrive files, search, billing, credits, notifications, App Store, custom objects (WeldObjects) | `core-platform`, `core-team`, `core-files`, `core-billing`, `core-apps`, `core-objects`, `core-integrations`, `core-onboarding`, `core-signin` |
| WeldCRM | Companies, people, leads, opportunities, pipelines, activities, quotes | `crm` |
| WeldDesk | Helpdesk tickets, conversations, SLAs, widget, help center | `desk`, `desk-widget` |
| WeldKnow | Knowledge spaces and pages | `know` |
| WeldMail | Email client, accounts, rules, campaigns | `mail` |
| WeldReach | Cold outreach campaigns and mailbox warm-up (staff-approved) | `reach` |
| WeldChat | Team chat | `chat` |
| WeldMeet | Video meetings | `meet` |
| WeldCalendar | Calendars, events, booking pages | `calendar` |
| WeldCall | Telephony | `call` |
| WeldFlow | Projects and personal tasks | `flow` |
| WeldBoard | Whiteboards (WeldFlow's whiteboards moved here) | `board` |
| WeldDocs | Word processing with live co-editing | `docs` |
| WeldSheets | Spreadsheets with live co-editing | `sheets` |
| WeldForms | Forms and surveys | `forms` |
| WeldSign | Electronic signatures | `sign` |
| WeldCommerce | Being rebuilt from scratch (see below); phase 0 serves the overview | `commerce` |
| WeldStash | Warehouse management, and the product catalogue (`/api/products`) until WeldCommerce is back | `stash` |
| WeldBooks | Double-entry accounting, per-country tax | `books`, `books-*` |
| WeldHR | HR and payroll (NL, US) | `hr` |
| WeldHost | Domains and DNS | `host` |
| WeldSocial | Social publishing | `social` |
| WeldAds | Ad campaigns | `ads` |
| WeldData | Lead database and enrichment | `data` |
| WeldPanel | Product and web analytics, session recordings | `panel` |
| WeldMerge | Pull requests and issues across Git providers | `merge` |
| WeldPass | Secret vaults and team password manager | `pass` |
| WeldConnect | Workflow automation | `connect`, `integrations` |
| WeldAgent | Workspace AI agents | `agent` |
| WeldApps | Apps users build, hosted in a sandboxed iframe | `core-apps`, `external-api` |

The public API (`/v1`, `wsk_` keys) is `rust/modules/external-api`, the MCP
server `rust/modules/mcp`.

Old module names (`task`, `accounting`, `wms`, …) still appear in places;
`normalizeAppCode` in `@weldsuite/permissions` maps them.

**WeldCommerce is being rebuilt from scratch.** Its code was removed on
2026-11-20: the old `commerce` module, the platform pages, the B2B order
portal, all shipping (Sendcloud, PrintNode, parcels, returns, the parcel
portals), and the public API and MCP commerce surface. The tenant tables
(`products`, `orders`, `categories`, `parcels`, …) stay. `/api/products` is
served by the stash module in the meantime, and WeldStash ships pick lists
without a carrier. The rebuild goes into `rust/modules/commerce`.

## Repository map

**`apps/web/`**, browser frontends (dev port in brackets):
- `platform` (3000): the main SPA. Every module's UI lives here.
- TanStack Start on Node, run by the Helm chart: `admin` (3001, staff
  console), `sign-portal` (3023, the WeldSign signer portal, a thin client of
  the backend), `forms-portal` (3025; it still has a Cloudflare Worker build
  next to `build:node`), `storefront` (3031, WeldCommerce's online store
  renderer: shops built in the platform's editor, served on the shop's own
  host through the Rust server's storefront edge) and `pay-portal` (3033,
  WeldBooks' public page for invoices and quotes at `pay.<domain>`: a
  customer views, downloads, pays (Mollie) and accepts, by the token in the
  link from the e-mail; ADR BOOKS-014).
- Next.js: `api-docs` (3009), `docs` (3010, help.weldsuite.org),
  `commerce-starter` (3030, the MIT-licensed WeldCommerce starter shop on
  `@weldsuite/commerce-sdk`: a template to fork, never deployed, no internal
  imports; its static Vite variant with a publishable key, for
  `weld storefront deploy`, is `commerce-starter-static`, 3032).
- Vite SPAs: `helpdesk-widget` (3100), and `developer` (WeldApps developer
  portal) and `partner` (3203, reseller portal), which wait for the backend's
  partner and developer APIs (phase 9 of the Global retirement plan).
- `weldpass-extension`: WeldPass browser extension, built and loaded by hand.

**`apps/mobile/`**: one Expo app per module, plus `_template` and `_shared`.
They are being replaced by native apps, one at a time, WeldPass first
(plan `weldsuite-documentation/plans/native-mobile-apps.md`): **`apps/ios/`**
(Swift, SwiftUI, Tuist) and **`apps/android/`** (Kotlin, Compose, Gradle),
both built from **`apps/mobile-shared/`** (the OpenAPI contract, strings and
design tokens; `pnpm mobile:generate`).
**`apps/desktop/`**: Electron shell around the platform.
**`apps/tools/`**: `storybook`, `test-dashboard`, `collab-rooms` (the
Docs/Sheets/Board rooms on Node for Kubernetes).
**`apps/hosted-apps/`**: first-party WeldApps, deployed with `weld app deploy`,
never compiled into the platform (see its README).
**`rust/`**: the backend: one binary (`rust/bins/weldsuite`: the server, its
crons and queue consumers, the migrations), the modules (`rust/modules`), the
shared and domain crates (`rust/crates`), the schema (`rust/crates/schema`),
the master and tenant migrations (`rust/migrations`) and the Helm chart.

**`packages/`**, all scoped `@weldsuite/*` and always imported by package name,
never by path:
- `config/`: eslint and TypeScript configs.
- `core/`: shared primitives: `db` (the Drizzle schema, frozen since the
  schema moved to Rust and read by the admin console and collab-rooms; the
  personal database's migrations; the pglite test harness), `permissions`,
  `entity-events`, `feature-flags` (the flag catalog), `i18n`, `ai` (the AI
  catalog and rates, exported to Rust), `emails` (system email templates),
  `realtime` (the realtime client and React hooks), `collab` and the docs,
  sheets, board and forms engines.
- `domains/`: module code the frontends or collab-rooms share: the docs,
  sheets and board rooms (`docs-domain`, `sheets-domain`, `board-domain`),
  WeldBooks' invoice templates and jurisdiction data, the payroll engines,
  WeldPanel's wire format.
- `clients/`: `app-api-client` (typed client and the shared Zod schemas),
  `api-client` (the HTTP transport), `core-api-client` (still load-bearing
  Zod schemas despite its name), `personal-api-client`, `mobile-platform`.
- `design/`: `ui` (the shared component library), `mobile-ui`,
  `storefront-theme` (WeldCommerce's online store theme: the site document,
  the section catalog the Rust backend validates against, the sections),
  `weldmeet-ui`, `forms-renderer`.
- `sdk/`: published, permissively licensed SDKs: `app-sdk`, `cli`,
  `helpdesk-widget-sdk`, `forms-embed`, `panel-sdk`, `cursor-plugin`,
  `commerce-sdk`.

## Commands

```bash
pnpm install                 # after every pull
pnpm dev                     # everything, through turbo
pnpm build                   # also: pnpm lint, pnpm format
pnpm storybook               # component playground
pnpm create:mobile-app       # scaffold a mobile app from _template
```

The backend runs locally as `weldsuite serve` on port 8080 (`rust/README.md`,
"Running it").

Per workspace, use `pnpm --filter <name> <script>`; app names are the folder
names (`platform`, `admin`, `sign-portal`, …), packages their package name:

```bash
pnpm --filter platform test            # also dev, build, lint, type-check
pnpm --filter @weldsuite/sheets-domain test   # room and service tests on in-memory Postgres (pglite)
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

Rust: `pnpm rust:lint`, `pnpm rust:test`, `pnpm rust:catalogs`; see
`rust/AGENTS.md`.

## Rules for every change

### Where code goes

- **A module's endpoints go in its Rust module** (`rust/modules/<module>`).
  Routes are organised by object (customers, tickets, …), and one endpoint
  backs every surface: platform, mobile, MCP.
- End to end: shared Zod schema in `@weldsuite/app-api-client` → route in
  `rust/modules/<module>` (logic other modules or the binary need goes into a
  crate in `rust/crates`) → client in `@weldsuite/app-api-client` → hook in
  `apps/web/platform/hooks/queries/use-<entity>-queries.ts`.
- **A new path prefix is registered** for its module in
  `rust/catalogs/api-modules.json`.
- **Module crates never depend on each other**, only on shared crates.
- Responses are `{ data }`, `{ data, pagination: { totalCount, hasMore, cursor } }`,
  `{ error: { code, message, details? } }`, or 204 for a delete
  (`rust/crates/kit`).
- **Every route checks a permission** (`PermissionGate::require` in
  `rust/crates/permissions`, the port of `@weldsuite/permissions`).
- **Every mutation publishes an entity event** (`publish_entity_event` in
  `rust/crates/events`), after the write succeeds and before returning. It
  feeds audit, analytics, search, webhooks, workflows, agents and realtime.
  Entity types and actions come from `packages/core/entity-events/src/events/`
  (exported by `pnpm rust:catalogs`). WeldPass is the one exception.

### Data

- **Two kinds of database**: a master DB (workspaces, users, billing,
  registries) and one tenant DB per workspace (its business data). Their
  schemas are the SeaORM entities in `rust/crates/schema/src/{master,tenant}/`,
  one per table with its DDL (ADR DATA-019). The Drizzle schema in
  `packages/core/db/src/schema/` is frozen: the admin console and collab-rooms
  still read it, but schema changes go into the entities. The personal DB of
  the retired consumer product (ADR DATA-011) keeps its Drizzle migrations in
  `@weldsuite/db`.
- **Scope every tenant query by workspace.**
- `workspaces.id` (`ws_…`) identifies a workspace everywhere; the old Clerk
  org id (`org_…`, `clerk_org_id`) is only for stores still keyed by it. Store
  `workspaces.id` in anything new, and match a value that may be either with
  `matchWorkspaceRef` (`@weldsuite/db/lib/workspace-ref`), never by prefix
  (ADR SEC-011).
- Ids are `varchar(30)` with a type prefix (`rust/crates/kit/src/id.rs`).
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

No cron, scheduled job, polling loop or queue job may iterate workspaces and
open each tenant database to check whether anything is due: with hundreds of
workspaces that opens every database on every tick. Keep the timing in an
always-on store and open a tenant only when it has work:

- **The workspace due index** on the master DB, `workspace_due_index`
  (`rust/crates/db/src/due_index.rs`: `mark_due`, `sync_due`, `run_sweep`).
  Write paths pull a workspace's due time earlier; a sweep lists only the due
  rows. A new sweep of that shape adds a kind there, not a new table.
- **The master DB**, when the data already lives there.
- **Event-driven work** only touches the tenant that produced the event,
  which is fine.

If the index can't be read, skip the tick and log it; never fall back to a
tenant fan-out. In the browser, polls that are mounted everywhere (badges,
unread counts) use `useIdleAwareRefetchInterval`
(`apps/web/platform/hooks/use-user-idle.ts`) so they stop when nobody is there.

### One backend

Global's TypeScript backend was deleted (ADR OPS-025, phase 8 of
`weldsuite-documentation/plans/retire-global-edition.md`): every feature is
built once, in Rust.

Part of `rust/catalogs` is exported from the TypeScript packages the frontends
share. After changing entity events, permissions, feature flags, the AI
catalog, the forms templates or the WeldConnect templates, run
`pnpm rust:catalogs` and commit the `rust/` changes; Lint fails when the export
is stale. The catalogs only the backend reads (`api-modules.json`,
`record-chat.json`, `core-platform-prefixes.json`, `first-party-origins.json`,
`connectors.json`, `odata.json`, and WeldConnect's pickers and providers in
`weldconnect.json`) are edited in the JSON.

### AI

- All LLM calls go through `rust/crates/ai` (ADR AI-012, design doc
  `design/platform/ai-platform.md`). Mistral is the install's provider; a
  workspace admin may opt in to non-EU providers. Call sites ask for a
  feature, a task and a tier, never a provider. No direct provider calls
  elsewhere.
- The crate charges every call to the workspace credit wallet, for the model
  that served; a fallback never leaves the EU.
- WeldAgent's workspace agents run on the Rust agent loop
  (`rust/modules/agent`, ADR AGENT-016; design doc
  `design/modules/weldagent.md`).
- `@weldsuite/ai` only holds the catalog and rates the frontends show; they
  are exported to `rust/catalogs/ai.json`.

### Outside services

- System emails are React Email templates in `@weldsuite/emails`.
  `pnpm rust:emails` exports them to `rust/catalogs/emails`, and the Rust
  server renders and sends them (`rust/crates/emails`, skill
  `weldsuite-email`). Lint fails when the export is stale.

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
  web frontend: the platform, `@weldsuite/ui`, the portals and the storefront
  renderer and theme, admin,
  partner, developer, docs, the helpdesk widget, the WeldPass extension and
  the hosted WeldApps. Not for the backend (Rust), SQL, CI, scripts,
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
  `Build`, `Type Check · packages`, `Type Check · platform`, `Unit · packages`,
  `Unit · platform`, `Rust` and `WeldSuite Review`. CI job names are required
  status checks; don't rename them. On a PR, jobs run only for the areas the
  change touches (`.github/scripts/ci-changes.mjs`).
- **The EU test cluster** runs the `main` builds of "Rust images"
  (`rust-images.yml`). **EU production** follows it automatically once a
  build has soaked on test and CI has passed (`eu-production-watch.yml`, ADR
  OPS-020). The cluster pins live in the private repo
  `weldsuite/weldsuite-deploy`; a rollback or a hold is its Promote workflow
  with target `eu`. Self-hosted installs get tagged releases
  (`rust-release.yml`).
- **Nothing deploys to Global.** Its deploy (Workers, Pages, Vercel apps,
  Expo OTA updates, hosted WeldApps) was removed on 2026-11-28, after its
  workspaces moved into EU production (ADR OPS-025), and its workers were
  deleted from this repo. A merge reaches only the EU install.

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
  `backend-rust`, `database`, `mobile-expo`, …), domain
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
- Every touched query is scoped by workspace; every new or changed route
  checks a permission and validates its input; every new mutation publishes an
  entity event.
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
- Look for `apps/workers` (Global's Hono workers: `app-api`, the
  `<module>-api` workers, `personal-api`, …), `@weldsuite/worker-kit`,
  `@weldsuite/api-modules`, `rust/conformance`, `apps/core-api`,
  `apps/api-worker`, `apps/mobile-api-worker` or the old AI workers
  (`agent-worker`, `agent-service`, `ai-worker`): they were deleted.
