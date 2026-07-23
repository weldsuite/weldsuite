# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

WeldSuite is a pnpm + Turborepo monorepo containing the WeldSuite business platform and its surrounding apps. The main user-facing platform is a **Vite + React 19 SPA** with **TanStack Router** (file-based routing) and **Clerk** auth. Backend services run as **Hono on Cloudflare Workers**, talking to a multi-tenant **Neon Postgres** through Drizzle ORM. Node 20+, pnpm 10.4.1.

Module names use the `weld*` family: **WeldCRM, WeldCommerce, WeldDesk** (helpdesk), **WeldMail, WeldFlow** (projects), **WeldConnect** (personal tasks), **WeldStash** (WMS), **WeldHost** (domains), **WeldBooks** (accounting), **WeldMeet** (meetings), **WeldChat** (team chat), **WeldAgent** (AI), **WeldApps** (user-created apps). Some legacy code still uses the old names (`task`, `accounting`, `wms`, `host`); a shim in `use-installed-apps.ts` bridges them.

### WeldApps, user-created apps

Users build their own apps for the platform: static bundles hosted in R2, rendered in a sandboxed iframe at `/apps/{code}`, distributed via the app store (`private` = authoring workspace only; `public` = global store after manual review), billed monthly via Stripe (+Connect payouts).

- **Master DB**: `user_apps`, `user_app_versions`, `user_app_installs` (workspace consent grants), `user_app_tokens` (`wsat_` tokens, SHA-256 registry like `api_key_registry`), `user_app_oauth_clients`, `app_developer_accounts`, `packages/core/db/src/schema/user-apps.ts`. Tenant DB: `app_records` / `app_kv` generic app storage (`user-app-data.ts`), apps never get their own tables.
- **Manifest** (`weldapp.json`): Zod schema in `@weldsuite/app-api-client/schemas/user-apps` (copies in `packages/sdk/cli/src/manifest.ts`, keep in sync). Declares scopes, storage collections, and `agentTools` (auto-exposed via mcp-server + `GET /v1/user-apps/agent-tools`).
- **Management API**: `apps/workers/app-api/src/routes/user-apps/` (Clerk) + public bundle host at `/public/user-apps/:code/*`. CLI/dev surface: `apps/workers/external-api/src/routes/v1/user-apps.ts` (wsk_ keys, scope `user-apps:manage`). App data plane: `/v1/app-storage` + OAuth `client_credentials` at `/v1/oauth/token` (external-api).
- **Platform UI**: iframe host + postMessage bridge `apps/web/platform/app/weldapps/host/`, developer pages `app/weldapps/manage/`, store section `app/appstore/custom-apps-section.tsx`. Permissions: `weldapps:read|develop|publish|manage`.
- **Agent-first tooling**: `packages/sdk/app-sdk` (`@weldsuite/app-sdk`, bridge + typed API client + React hooks) and `packages/sdk/cli` (`@weldsuite/cli`, `weld app init/create/deploy/publish`, `weld skill install`), the scaffold ships a `.claude/skills/weldsuite-app` skill + CLAUDE.md. The SDK bridge protocol must stay in lockstep with the platform host page.

## Monorepo Structure

### Apps (`apps/`), grouped by runtime

Apps live under category folders: **`web/`** (browser), **`workers/`** (Cloudflare), **`tools/`** (dev/ops), **`mobile/`** (Expo), plus the lone **`desktop/`**. App `package.json` names are **bare kebab-case** (no scope).

**`apps/web/`**, browser frontends:
- `platform`, **Main Vite + React 19 SPA.** All web modules live here.
- `sites`, Next.js customer-website renderer (port 3007)
- `helpcenter`, Next.js knowledge base, Flexsearch (port 3008)
- `admin`, Next.js internal admin console
- `api-docs`, Next.js public API documentation site
- `helpdesk-widget`, Embeddable Vite chat widget (port 3100)
- `booking-portal`, `meeting-portal`, `parcel-tracking-portal` (3018), `parcel-return-portal` (3017), Public-facing Next.js portals

**`apps/workers/`**, Cloudflare Workers (Hono):
- `app-api`, **The unified first-party backend. All endpoints live here.** Serves the platform SPA + all mobile apps. Successor to the now-deleted `api-worker`/`core-api`/`mobile-api-worker`.
- `external-api`, Third-party public API (`api.weldsuite.org`, `wsk_` keys)
- `mcp-server`, WeldSuite MCP server
- `billing-worker`, Stripe billing + subscriptions
- `workspace-worker`, Workspace provisioning
- `realtime-worker`, Real-time fan-out (Cloudflare Durable Objects + WebSocket)
- `workflow-worker`, WeldConnect execution engine (hosts the schedule-sweep cron)
- `helpdesk-widget-api`, Widget backend (`@weldsuite/realtime`)
- `helpdesk-workflow-worker`, Helpdesk automation engine
- `mail-inbound-worker`, Inbound email (Svix webhooks, postal-mime)
- `analytics-worker`, `audit-log-worker`, Event streams
- `integration-webhook-worker`, `integration-sync-worker`, Third-party integrations
- `discord-bot-worker`, Discord integration worker (`discord-bot` bot process is under `tools/`)
- `test-email-worker`, Email testing harness

> **AI note:** the former `agent-worker`, `agent-service`, and `ai-worker` are gone (AI teardown 2026-07-08). AI now runs through the `@weldsuite/ai` package (Vercel AI SDK via Cloudflare AI Gateway); credit metering happens at the `app-api` layer. There is no `AGENT_WORKER` service binding anymore.

**`apps/tools/`**, dev/ops tooling (not deployed as product):
- `migrate-databases`, Tenant migration runner (`tsx src/index.ts`, supports dry-run)
- `storybook`, Component playground (run via root `pnpm storybook`)
- `test-dashboard`, Internal test-results dashboard
- `discord-bot`, Discord bot process (companion to `discord-bot-worker`)

**`apps/mobile/`**, Expo / RN 0.81, Expo 54:
- `weldsuite-app` (main) + per-module standalone apps: `welddesk-app`, `weldmail-app`, `weldchat-app`, `weldbooks-app`, `weldcrm-app`, `weldflow-app`, `weldmeet-app`, `weldsocial-app`
- `_template`, Scaffold for new mobile apps (see root script `create:mobile-app`)

**`apps/desktop/`**, Desktop app shell (lone top-level app).

> **Secrets tooling note:** worker secrets are keyed by bare worker name in `scripts/secrets/manifest.ts`; the sync scripts resolve them under **`apps/workers/<name>`**.

### Packages (`packages/`), grouped by role

All internal packages are scoped **`@weldsuite/*`** and live under category folders: **`config/`** (eslint-config, typescript-config), **`core/`** (db, permissions, i18n, ai, realtime, credits, entity-events, feature-flags, notifications, email, transactional-email, cloudflare-realtime, cloudflare-registrar, neon-provisioning, workflow-integrations, df3-noise-suppression), **`clients/`** (api-client, app-api-client, core-api-client), **`design/`** (ui, mobile-ui, site-components, weldmeet-ui), **`sdk/`** (app-sdk, cli, helpdesk-widget-sdk, the published, permissive-licensed ones). Imports use the package **name** (`@weldsuite/db`), never the path, so the category folder is transparent to consumers.

- `@weldsuite/db`, Drizzle schema (~198 files; shared by ALL apps), `packages/core/db`
- `@weldsuite/app-api-client`, Typed client + shared Zod schemas for `app-api` (the current stack)
- `@weldsuite/core-api-client`, **Not obsolete despite the name:** its Zod schemas are load-bearing for the new stack (`app-api` imports them in ~116 files, `external-api` in ~41). Slated to fold into `@weldsuite/app-api-client` eventually.
- `@weldsuite/api-client`, **Not obsolete despite the name:** the HTTP transport of the new stack (platform + mobile app-api clients build on it).
- `@weldsuite/ui`, `@weldsuite/mobile-ui`, `@weldsuite/site-components`, `@weldsuite/weldmeet-ui`, Shared UI
- `@weldsuite/permissions`, RBAC; `weld*` prefixes, `requirePermission()` middleware, `usePermissions()` hook
- `@weldsuite/i18n`, Cookie-based en/nl translations
- `@weldsuite/ai`, AI integration (Vercel AI SDK via Cloudflare AI Gateway). *(The old `agent-runtime` / `agent-tools` packages were removed in the AI teardown.)*
- `@weldsuite/credits`, `@weldsuite/entity-events`, `@weldsuite/feature-flags`, `@weldsuite/notifications`, Platform primitives
- `@weldsuite/email`, `@weldsuite/transactional-email`, Email sending
- `@weldsuite/realtime`, `@weldsuite/cloudflare-realtime`, Realtime helpers
- `@weldsuite/cloudflare-registrar`, `@weldsuite/neon-provisioning`, Infra abstractions
- `@weldsuite/app-sdk`, `@weldsuite/cli`, `@weldsuite/helpdesk-widget-sdk`, Published SDKs (permissive-licensed for embedding)
- `@weldsuite/eslint-config`, `@weldsuite/typescript-config`, Shared configs

## Development Commands

### Root
```bash
pnpm install              # Install all deps
pnpm dev                  # Run everything via turbo
pnpm dev:safe             # Skip Prisma generate during dev
pnpm build                # turbo build
pnpm lint                 # turbo lint
pnpm format               # Prettier
pnpm storybook            # Storybook
pnpm create:mobile-app    # Scaffold a new mobile app from _template
```

### Platform (`apps/web/platform`)
```bash
pnpm dev                  # Vite dev server (port 3000)
pnpm build                # Vite production build
pnpm type-check           # tsc --noEmit
```

### Database (`packages/core/db` + `apps/tools/migrate-databases`)
```bash
# Generate / inspect migrations (from packages/db)
pnpm --filter @weldsuite/db db:generate          # Tenant Drizzle migration
pnpm --filter @weldsuite/db db:generate:master   # Master Drizzle migration
pnpm --filter @weldsuite/db db:migrate:master    # Apply master migrations
pnpm --filter @weldsuite/db db:studio            # Drizzle Studio

# Apply tenant migrations across all workspaces (from apps/tools/migrate-databases)
pnpm --filter migrate-databases db:migrate:tenants
pnpm --filter migrate-databases migrate:dry-run
```

### E2E (Playwright, Platform)
```bash
pnpm test:e2e             # All specs
pnpm test:e2e:ui          # Playwright UI (recommended for dev)
pnpm test:e2e:headed      # Visible browser
pnpm test:e2e:debug       # Debugger
pnpm test:e2e:report      # Last report

# Single spec
pnpm exec playwright test e2e/specs/wms/products.spec.ts
```
Requires platform on 3000, `app-api` running locally, and `.env.test` with `TEST_USER_EMAIL` / `TEST_USER_PASSWORD`. Chromium only. CI: 1 worker / 2 retries. Local: parallel / 0 retries.

### Mobile (`apps/mobile/<app>`)
```bash
pnpm test                 # Jest
pnpm test:watch
pnpm test:coverage
```

### Cloudflare Workers (any worker app)
```bash
pnpm dev                  # wrangler dev
pnpm deploy:test
pnpm deploy:preview
pnpm deploy:production
```

### DB Migrations (`apps/tools/migrate-databases`)
```bash
pnpm migrate              # Run on all tenant DBs
pnpm migrate:dry-run      # Preview without applying
```

### Adding shadcn components
```bash
pnpm dlx shadcn@latest add [component-name] -c packages/ui
# For the platform's own local components:
pnpm dlx shadcn@latest add [component-name] -c apps/web/platform
```

## Architecture

### Platform, Vite SPA, NOT Next.js

This is critical: the platform has **no server components, no server actions, no middleware.ts**. All data fetching is client-side.

- **Routing**: TanStack Router file-based, via `@tanstack/router-plugin/vite`. Route files in `apps/web/platform/src/routes/` are thin wrappers; the actual component code lives in `apps/web/platform/app/` organized by module.
- **`src/routeTree.gen.ts`** is auto-generated, never edit.
- **Path alias**: `@` → `apps/web/platform/`
- **Env vars**: `VITE_*` prefix
- **Layout groups**: `_dashboard/` (main app), `_builder/` (website builder), `_preview/`, `auth/`, `settings/`

Route file pattern:
```typescript
// src/routes/commerce/products/index.tsx
import PageComponent from '@/app/commerce/products/page';
export const Route = createFileRoute('/commerce/products/')({ component: PageComponent });
```

Provider stack (in `src/routes/__root.tsx`):
```
ClerkProvider → ApiClientProvider → QueryProvider → ThemeProvider → I18nProvider
→ SettingsProvider → NotificationProvider → WorkspaceProvider → PlatformEventsProvider
→ AppShellClient → Outlet
```

### Auth (client-side Clerk)
```typescript
import { useAuth, useUser } from '@clerk/clerk-react';
const { getToken } = useAuth();        // JWT for API calls
const { user } = useUser();
```

### API Client Patterns

**All new client code targets `app-api`.** `useCoreApi()` and `useApiClient()` are legacy hooks for the obsolete `core-api` and `api-worker` workers, existing call sites should be migrated to the `app-api` client.

### App API, where new endpoints go (`apps/workers/app-api`)

**`app-api` is the unified first-party API.** It is the successor to `core-api`, `api-worker`, and `mobile-api-worker`, and serves both the platform SPA and all WeldSuite mobile apps from a single hostname (`app-api.weldsuite.org`). Third-party integrations stay on `external-api` (`api.weldsuite.org`).

**Stack:** Hono + Workers + Neon (Drizzle) + Clerk + cursor pagination.

Routes are organised **by object** (customers, contacts, tickets, …) to mirror the object-based permission model, one canonical endpoint backs every surface across the platform and mobile apps.

End-to-end for a new endpoint:

1. **Schema** → shared Zod schemas package (Zod v3, shared client+server)
2. **Service** → `apps/workers/app-api/src/services/<entity>.ts` (pure functions, no Hono context)
3. **Route** → `apps/workers/app-api/src/routes/<entity>/index.ts`, mount in `apps/workers/app-api/src/index.ts`
4. **Domain API / client** → typed wrapper consumed by both platform and mobile
5. **Hook** → `apps/web/platform/hooks/queries/use-<entity>-queries.ts`

Response shape:
```typescript
{ data: T }                                                                   // single
{ data: T[], pagination: { totalCount, hasMore, cursor: string | null } }     // list
{ error: { code, message, details? } }                                        // error
// 204 No Content                                                             // delete
```

Key files:
- `apps/workers/app-api/src/index.ts`, entry, middleware, route mounts
- `apps/workers/app-api/src/lib/response.ts`, `success()`, `error.*`, `list()`, `cursorPagination()`
- `apps/workers/app-api/src/middleware/`, `clerk.ts`, `workspace-db.ts`, `request-id.ts`

**Entity events**, every mutation route must publish an entity event so audit logging, workflows, analytics, realtime, and AI agents stay wired:

```ts
import { publishEntityEvent } from '@weldsuite/entity-events';

// after the insert/update/delete succeeds, before returning:
publishEntityEvent({
  c,
  entityType: 'customer',   // catalog-typed, typos fail at compile time
  action: 'created',
  entityId: newCustomer.id,
  data: newCustomer as unknown as Record<string, unknown>,
});
return success(c, newCustomer, 201);
```

Fire-and-forget, uses `c.executionCtx.waitUntil(...)` internally, never blocks the response. Missing queue/realtime bindings log a warning and no-op. The events catalog at `packages/core/entity-events/src/events/` is the single source of truth for entity types + actions; agent `eventSubscriptions` and workflow `entity_event` triggers validate against the same registry.

### Deleted: `apps/core-api`, `apps/api-worker`, `apps/mobile-api-worker`

All three legacy backends were **deleted from the repo on 2026-07-17**; `app-api` is the only first-party backend. There is nothing to migrate or bugfix in them, every route lives under `apps/workers/app-api/src/routes/` (Hono + Drizzle, `clerkMiddleware()` → `workspaceDbMiddleware()` setting `c.get('tenantDb')`, organised by object). ⚠️ The Cloudflare workers may still be *deployed* and serving during the cutover window, that retirement is tracked in `.claude/open-source-plan.md`, not here.

### Database (Drizzle + Neon, multi-tenant)

- Schema in `packages/core/db/src/schema/` (~198 files)
- Drizzle migration artifacts (SQL + meta journal) in `packages/core/db/drizzle/{master-migrations,tenant-migrations}/`
- Generation (`drizzle-kit`) is owned by `packages/core/db`; tenant runner lives in `apps/tools/migrate-databases`
- `apps/web/platform` no longer owns migrations, do not put `drizzle/` or `drizzle.config.ts` back into it
- `varchar(30)` IDs via `generateId('prefix')` from `lib/id`
- JSONB columns typed via `.$type<T>()`
- **Master DB**: cross-tenant (workspaces, users, billing)
- **Tenant DB**: per-workspace business data
- Production uses Cloudflare Hyperdrive; dev uses direct Neon URL
- Field-level encryption supported via worker secret
- **Adding columns/tables to `packages/core/db/src/schema/` is fine. Do NOT create migration files, ask the user first.**

### AI / Agents

AI runs through the **`@weldsuite/ai`** package (Vercel AI SDK via the Cloudflare AI Gateway REST API, one CF token reaches both Workers AI `@cf/*` models and third-party providers). Credit metering happens at the **`app-api`** layer (`services/ai/billing.ts`), against the prepaid workspace wallet.

> The old dedicated AI runtime, `apps/agent-worker`, `apps/agent-service` (Mastra.ai on Hetzner), `apps/ai-worker`, and the `@weldsuite/agent-runtime` / `@weldsuite/agent-tools` packages, was removed in the AI teardown (2026-07-08) and is being rebuilt on top of `@weldsuite/ai`. There is no `AGENT_WORKER` service binding.

### Cloudflare Infra

- **Hyperdrive**, Neon pooling
- **KV**, Workspace cache + config
- **R2**, Files / attachments
- **Queues**, `audit-events`, `workflow-events`, `analytics-events`
- **Service Bindings**, Cross-worker calls (e.g. helpdesk widget → workflow worker, integration workers → `app-api`)
- **Realtime**, `@weldsuite/realtime` (Cloudflare Durable Objects + WebSocket; notifications, live chat); token via `/api/realtime/token`

### i18n
```typescript
import { getTranslations, getLocale, setLocale } from '@/lib/i18n';
const t = getTranslations('common');   // typed
setLocale('nl');                       // cookie
```
Locales: `en`, `nl`. Files in `apps/web/platform/lib/i18n/locales/`. **Any new user-visible string must have entries in both `en.json` and `nl.json`.**

### UI

The **platform** has its own local shadcn components at `apps/web/platform/components/ui/`. `@weldsuite/ui` is consumed by sites/portals/widget/helpcenter, not by the platform.

### State
- **Server state**: TanStack Query
- **Client state**: Jotai
- **Forms**: React Hook Form + Zod resolver

## CI/CD

GitHub Actions `.github/workflows/deploy.yml` (triggered on push to `main` / `develop`):
1. **Prepare**, `main` → production, `develop` → test. Detects migration + SDK version changes.
2. **Migrations**, Master DB, then all tenants.
3. **Workers Deploy**, All workers in parallel to Cloudflare (test/preview/production).
4. **Widget SDK Publish**, npm with OIDC provenance when `@weldsuite/helpdesk-widget-sdk` version changes.

Other workflows: `migrate-database.yml` (manual), `publish-widget-sdk.yml` (manual), `sync-secrets.yml`.

`.github/actions/setup-monorepo/action.yml` pins pnpm 10.4.1 + Node 20 and caches the pnpm store + turbo cache.

Environments: dev (local wrangler) → test (`develop`) → preview (manual) → production (`main`).

## Critical Files

1. `apps/web/platform/vite.config.ts`, Vite + TanStack Router plugin + aliases
2. `apps/web/platform/src/main.tsx`, Entry (ClerkProvider, RouterProvider)
3. `apps/web/platform/src/routes/__root.tsx`, All providers
4. `apps/web/platform/src/routeTree.gen.ts`, Auto-generated (DO NOT EDIT)
5. `apps/web/platform/lib/api/`, API client wiring (targets `app-api`)
6. `apps/workers/app-api/src/index.ts`, Unified backend entry (the only first-party backend)
7. `apps/workers/app-api/wrangler.toml`, Bindings + env
8. `packages/core/db/src/schema/`, All Drizzle schema
   `packages/core/db/drizzle/`, All Drizzle migrations (master + tenant SQL + meta journal)
   `apps/tools/migrate-databases/src/index.ts`, Tenant migration runner used by CI
9. `turbo.json`, Build pipeline
10. `.github/workflows/deploy.yml`, Deployment

## Important Notes

- **NOT Next.js, Vite SPA.** No server components, server actions, or middleware.ts in the platform.
- **`app/` holds components, `src/routes/` holds route wrappers.** Despite the name.
- **Never edit `apps/web/platform/src/routeTree.gen.ts`.**
- **Schema changes**: edit `packages/core/db/src/schema/` freely, but never create migration files without explicit user approval.
- **Zod v3 only** in app code. Root `package.json` may show v4 in overrides; ignore, do not upgrade app imports.
- **Tailwind v4** via `@tailwindcss/vite`.
- **Helpdesk widget SDK + test page**: changes to `packages/sdk/helpdesk-widget-sdk/src/core/IframeManager.ts` must be mirrored in `apps/web/helpdesk-widget/test-local.html` (and vice versa). The test page replicates the SDK's iframe + postMessage protocol.
- **Sites / helpcenter / portals are Next.js** (not the platform).
- Run `pnpm install` after pulling to sync workspaces.

---

## Claude Code Agent Workflow (Bug Fixing + Feature Work)

This repo runs an agent-driven workflow. Specialist sub-agents live in `.claude/agents/`. WeldSuite itself (via the `weldsuite` MCP) is the project management system.

### MCP, `weldsuite`

- `mcp__weldsuite__get_task` / `search_tasks` / `search_projects`, pull work
- `mcp__weldsuite__update_task`, comment + status flip on completion
- `mcp__weldsuite__create_task`, file new bugs found during triage
- `mcp__weldsuite__search_tickets` / `get_ticket`, for WeldDesk-originated reports

### Specialist agents

**Orchestration:**
- `task-enricher`, Step 0 of any /fix-bug or /feature. Reads the task, explores the repo (~10 reads), then **interviews the user** in dynamic rounds via AskUserQuestion. Appends an "Enriched analysis" block to the task description after user approval. Self-skips if one already exists.
- `github-issue-enricher`, GitHub-issue twin of `task-enricher` (run via `/enrich-issue <number>`). Same explore→interview→draft→approve flow, but reads/writes the issue via `gh` and appends the "Enriched analysis" block to the **issue body** so an assigned agent (local specialist or the `@claude` Action) inherits full context. Self-skips if already enriched. `--auto` queues a `## Pending interview` block for a silent backlog pass.
- `weldsuite-dispatcher`, Classifies and routes the enriched task to specialists.
- `bug-triage`, Reproduces, root-causes, writes a fix plan with file paths + lines BEFORE coding.

**Stack:**
- `frontend-platform`, apps/web/platform (Vite SPA)
- `frontend-nextjs`, sites / helpcenter / portals
- `mobile-expo`, apps/mobile/*
- `backend-app-api`, all backend endpoints (`apps/workers/app-api`, the only first-party backend)
- `backend-workers`, cron / queue / other Cloudflare workers
- `database`, packages/core/db schema + Drizzle + Neon

**Domain:** `weldflow-projects`, `weldmeet-meetings`, `weldcrm`, `welddesk-helpdesk`, `weldmail`, `weldbooks-accounting`, `weldsuite-invoicing`, `weldsuite-time-tracking`, `weldhost-domains`, `weldcommerce`, `weldsuite-wms`, `weldagent-ai`, `weldsuite-social`

**Country accounting:** `accounting-be`, `-nl`, `-de`, `-fr`, `-uk`, `-us`

### Autopilot

Two complementary automations:

1. **Manual batch pre-work**, Cowork scheduled task `weldsuite-autoenrich-hourly` (auto-run disabled). Click **Run now** to queue questions on up to 10 unenriched tasks. Appends a `## Pending interview` block (questions only, no draft). Writes `.claude/autopilot/digest-YYYY-MM-DD.md`.
2. **`/autopilot`**, Interactive loop. Claim → interview → dispatch → triage → implement → DoD, per task. Hard stops: interview, can't-reproduce, DB migration, PR open. Default cap 5 iterations.

### Slash commands (`.claude/commands/`)

- `/list-bugs`, open bug backlog sorted by priority
- `/enrich <id>`, enrichment only (WeldSuite MCP task)
- `/enrich-issue <number> [--auto]`, enrichment only for a **GitHub issue**; writes the `## Enriched analysis` block into the issue body via `gh issue edit` (twin of `/enrich`). `--auto` does a silent pre-work pass (queues a `## Pending interview` block instead of interviewing).
- `/fix-bug <id> [--skip-enrich]`, enricher → dispatcher → triage → specialist
- `/fix-issue <number> [--skip-enrich]`, end-to-end fix for a **GitHub issue**: enrich → branch → triage → specialist → full DoD (translations/tests/lint/build/type-check) → PR (`Closes #n`) → close. Full lifecycle in `.claude/ISSUE-FIX-WORKFLOW.md`.
- `/feature <id> [--skip-enrich]`, same flow for features (triage produces design sketch)
- `/autopilot [--max N]`, drive the backlog
- `/claim <id>`, assign self + in-progress
- `/done <id>`, DoD checks, comment, close

### Definition of Done

Before marking a task done:
- Reproduces before, doesn't after
- Tenant scoping (`workspaceId`) preserved on every touched query
- Permission check (`weld*` prefix) on new/changed routes
- Zod v3 validation both directions
- i18n entries in BOTH `en.json` and `nl.json` for any new string
- `pnpm lint` passes in changed workspace(s)
- `pnpm build` of touched app(s) passes
- No stray `console.log`, `any`, or `@ts-ignore`
- Schema changes flagged to user, no migration files without approval
- WeldSuite task updated with PR/commit and closed

### Do / Don't

**Do:**
- Run enrichment first (or let `/fix-bug` / `/feature` do it). Saves every downstream agent a round.
- Skim today's `.claude/autopilot/digest-<date>.md` if you ran batch pre-work.
- Prefer `/autopilot` for top-of-queue work.
- Read the triage plan before coding. If missing, run `bug-triage` yourself.
- Put all backend routes in `app-api`, it's the only first-party backend (`core-api`/`api-worker`/`mobile-api-worker` are deleted).
- Scope every Drizzle query by `workspaceId`.
- Ask before writing a migration.

**Don't:**
- Don't push an `## Enriched analysis` without user approval. Batch pre-work only ever writes `## Pending interview`.
- Don't bypass the four `/autopilot` hard stops.
- Don't overwrite a task's original description, enrichment is append-only below `---`.
- Don't re-enrich an already-enriched task (the enricher self-skips).
- Don't edit `apps/web/platform/src/routeTree.gen.ts`.
- Don't upgrade Zod to v4 in app imports.
- Don't reach for `apps/api-worker`, `apps/core-api`, or `apps/mobile-api-worker`, they're deleted. `apps/workers/app-api` is the home for all backend routes.
- Don't add direct Anthropic SDK calls, route AI through the `@weldsuite/ai` package.
- Don't "fix" a bug you couldn't reproduce, request info instead.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
