# Splitting app-api into one API worker per module

Status: **phase 0 implemented**; **phase 1 (WeldPass → pass-api) implemented**, first
steps of its rollout pending (see "Phase 1: rollout"). Both 2026-09-25. Owner decisions from the planning session (2026-09-25):

- Goals: **deploy independence**, **smaller bundles / faster startup**, **code ownership** per module.
- **One worker per `weld*` module**, each on its **own hostname**: `<module>-api.weldsuite.org`
  (production) and `<module>-api-test.weldsuite.org` (test).
- **Shared tenant DB.** No database split, no migrations needed for this project.
- **Incremental rollout.** One module at a time; app-api shrinks until only the platform core is left.

## Where we are

`apps/workers/app-api` is one Hono worker with 272 route folders, ~626 source files and
~171k lines. Every request loads all routers. The last dry-run bundle was 11.1 MB raw /
1.81 MB gzipped. That is well under the 10 MB (compressed) paid Worker limit, so the size
limit is not the urgent driver. The real costs are that every change redeploys everything,
startup work grows with every module, and nothing stops one module from reaching into
another's internals.

The coupling analysis (import graph over `src/`) shows the split is feasible. The code is
already organised by module, and module-to-module imports are few (~90 edges, most of them
to a handful of files that are really shared helpers):

| From → to | Imports | What it is |
|---|---|---|
| connect → flow | 12 | `lib/tenant-work-index.ts` (really core) |
| ai ↔ chat | 7 + 5 | agent posts chat messages; chat mentions dispatch the agent (a cycle) |
| wms → commerce | 4 | `services/sendcloud/client.ts` (vendor client) |
| books/connect/mail/search → ai | 3+3+1+1 | `services/ai/billing.ts` (credit metering, really core) |
| desk → connect | 3 | `lib/discord.ts` (vendor client) |
| hr → commerce | 3 | `middleware/commerce-portal-slug.ts` (generic portal middleware) |
| mail → connect | 3 | `workflows/execute-sequence.ts` reuses workflow step runners |
| 6 modules → mail | 1–2 each | `lib/cloudflare-email.ts` (really core) |
| crm → chat, data → crm, ai → crm, commerce → connect, commerce → books, telephony → desk, meet → chat | 1–2 each | real cross-module side effects or lookups |

The de-facto core that every module imports: `db/index.ts`, `types.ts`, `lib/id.ts`,
`lib/response.ts`, plus `lib/log-safe.ts`, `lib/entity-context.ts`, `lib/atomically.ts`,
`services/custom-field-values.ts` and the realtime publishers.

A few core files import module code and have to be untangled first: `types.ts`
(→ weldagent jobs, custom-objects), `routes/internal` (→ mail, workflow-actions, telephony),
`routes/invitations` + `routes/roles` (→ weldchat role links / auto-join), `routes/search`
(→ ai billing), `routes/app-catalog` (→ mail access), `routes/billing` (→ internal email).

`apps/workers/personal-api` is the precedent: its own worker, its own `custom_domain`
hostname, same Hono + Clerk + Neon stack. It currently copies what it needs from app-api,
which is exactly the duplication this plan avoids with a shared kit.

## Target architecture

```
                 platform SPA / mobile apps / portals
        ┌───────────────┬───────────────┬───────────────┬── …
        ▼               ▼               ▼               ▼
  app-api.weldsuite.org  crm-api.…   desk-api.…     books-api.…      (custom domains)
  (core)                 crm-api     desk-api       books-api
        │                    │           │               │
        └──── @weldsuite/worker-kit (auth, tenant DB, CORS, response, ids, test harness)
        └──── @weldsuite/db ── one tenant DB per workspace (shared)
        └──── service-binding RPC between workers for cross-module side effects
        └──── entity-events queue (unchanged)
```

Key properties:

1. **Paths do not change.** A module worker serves exactly the `/api/<object>` paths it
   serves today. Only the host changes. The 55 domain modules in
   `@weldsuite/app-api-client` keep their paths; a resolver picks the host.
2. **app-api stays, as the core worker**, on `app-api.weldsuite.org`. No rename.
3. **app-api forwards moved prefixes** to the new worker over a service binding during
   the transition. Old mobile binaries, cached SPA tabs, the CLI and local dev keep working,
   and every cutover can be rolled back by flipping client config.
4. **Workers never import from each other.** Shared code lives in packages. Cross-module
   side effects go through RPC (`WorkerEntrypoint` over a service binding) or entity events.

### Module → worker map

The authoritative list is `packages/core/api-modules/src/index.ts`; the table below
is a summary. The map follows the platform's `app/weld*` folders and the `weld*`
permission prefixes. Changes made while writing the manifest: `sequences`,
`customer-sequences` and `lists` belong to **crm** (the UI lives in `app/weldcrm`), and
`digest-settings` belongs to **flow** (the task digest).

| Worker | Hostname prefix | Route folders | Non-HTTP work it takes over |
|---|---|---|---|
| `app-api` (core) | `app-api` | workspaces, me, account, auth-*, cli-auth, onboarding, invitations, roles, my-role, team-members, member-limits, prepaid-seats, access-requests, settings-profile, workspace-settings, user-preferences, notification*, push-tokens, files, folders, drive, storage, search, billing, credits, feature-flags, feature-requests, appstore, app-catalog, user-apps, public-user-apps, api-keys, workspace-api-keys, audit-logs, custom-fields, custom-object*, object-templates, grid-views, lists, dashboard, internal (core parts) | search-index queue, TrashCleanup, DeferredNotificationEmail |
| `crm-api` | `crm-api` | companies, people, person-companies, leads, opportunities, pipelines, pipeline-*, activities, customer-statuses, crm-analytics, lists, sequences, customer-sequences | ExecuteSequence |
| `desk-api` | `desk-api` | tickets, ticket-*, helpdesk-*, desk/conversations, desk/widget, conversations, canned-responses, slas, satisfaction-surveys, articles, article-folders, helpcenter-settings, public-helpcenter | |
| `mail-api` | `mail-api` | mail-*, mailboxes | SendScheduledEmail |
| `flow-api` | `flow-api` | projects, project-*, task-*, tasks, my-tasks, sprints, milestones, goals, whiteboards, documents, time-entries, digest-settings | digest cron, SendDigest, ImportTasks |
| `books-api` | `books-api` | accounting-*, invoices, bills, journal-entries, gl-accounts, bank-*, vat-returns, fiscal-periods, fx-rates, tax-rates, recurring-invoices, payments, reconciliation-rules, icp-declarations | |
| `commerce-api` | `commerce-api` | products, orders, categories, commerce-portal, public-commerce-portal, shipping-*, shipments, parcels, parcel-*, carriers, pickups, returns, return-*, sendcloud, printnode, woocommerce webhook | |
| `stash-api` | `stash-api` | warehouses, warehouse-*, inventory*, pick-lists, pickers, putaway, cycle-counts, stock-adjustments, boxes, purchase-orders, wms-* | |
| `host-api` | `host-api` | domains, dns-*, domain-transfers, email-forwards, webhooks-realtime-register | domain auto-renew cron |
| `calendar-api` | `calendar-api` | calendars, calendar-events, bookings, booking-pages, working-hours | calendar replan cron |
| `meet-api` | `meet-api` | meetings, meeting-*, transcriptions, webhooks-meeting-bot, webhooks-cloudflare-realtime | TranscribeRecording |
| `chat-api` | `chat-api` | chat-*, channels, channel-members | UnpinExpiredMessage |
| `call-api` | `call-api` | calls, call-intelligence, desk/phone, telephony, porting, telnyx webhook | |
| `connect-api` | `connect-api` | workflow*, workflows, connectors, integrations, external-webhooks, github-*, public workflow webhook, GitHub callback | |
| `agent-api` | `agent-api` | ai, ai-models, weldagent, chat-agent | entity-agents queue, routines cron, WeldAgentJob |
| `data-api` | `data-api` | welddata, enrichments, enrich-fields | WelddataEnrich |
| `know-api` | `know-api` | knowledge | |
| `hr-api` | `hr-api` | weldhr, public-hr-portal | |
| `social-api` | `social-api` | social-*, postpeer webhook | |
| `ads-api` | `ads-api` | ad-* | |
| `pass-api` | `pass-api` | weldpass | |

Module-specific AI endpoints (`mail-ai`, `helpdesk-weldagent`) stay in their module and call
`@weldsuite/ai` + the credit metering in the kit. `agent-api` only owns the agent runtime.

## Rules for cross-module code

Applied to every edge found when extracting a module:

1. **Generic helper → `@weldsuite/worker-kit`.** Examples: `cloudflare-email`,
   `ai/billing` (credit metering), `tenant-work-index`, `analytics-query`,
   `document-attachment`, `commerce-portal-slug` (becomes a generic portal middleware).
2. **Vendor API client → its own package** (`packages/core/<vendor>`), like the existing
   `@weldsuite/cloudflare-*` ones. Examples: Sendcloud, Discord, Telnyx.
3. **Reading another module's data:** allowed through `@weldsuite/db` for simple lookups
   (a company name, a ticket subject). The DB is shared, so an RPC round trip for a read
   buys nothing.
4. **Writing another module's data or triggering its side effects:** only through that
   module's RPC entrypoint (`export class CrmRpc extends WorkerEntrypoint`) or an entity
   event. Each module owns writes to its own tables.
5. **Workflow step runners shared by mail sequences and WeldConnect** move into the
   existing `@weldsuite/workflow-integrations` package.

Concrete resolutions for the edges we already know:

| Edge | Resolution |
|---|---|
| ai → chat (post agent message) | `ChatRpc.postAgentMessage` |
| chat → ai (mention dispatch) | entity event (`chat_message.created`) consumed by agent-api, or `AgentRpc.dispatchMention` |
| ai → crm / flow / mail (agent tools) | agent tools call module RPCs; reads go direct |
| crm → chat (`entity-channel`) | `ChatRpc.ensureEntityChannel` |
| data → crm (`services/companies`) | `CrmRpc.upsertCompany` |
| commerce → connect (publish product) | `ConnectRpc.publishProduct` |
| commerce → books (invoice HTML) | `BooksRpc.renderInvoiceHtml` |
| telephony → desk (`helpdesk-integrations`) | read direct; writes via `DeskRpc` |
| meet → chat (call lifecycle) | `ChatRpc` |
| wms → commerce (Sendcloud) | vendor package |
| everything → `cloudflare-email`, `ai/billing` | kit |

One caveat: an RPC call is not part of the caller's DB transaction. Any flow that today
writes two modules' tables atomically (to check while extracting: commerce order →
invoice, sequences → mail) either keeps the write in one module or becomes
write-then-event with an idempotent consumer.

Enforcement: an ESLint `no-restricted-imports` rule (or a `fallow` boundary rule) that
forbids importing from `apps/workers/*` outside the worker's own folder, plus a test that
fails when a route folder is not owned by exactly one module in the manifest.

## Phase 0: foundations (no traffic changes)

Everything here ships while app-api still serves 100% of traffic.

### 0.1 Module manifest: `packages/core/api-modules` (`@weldsuite/api-modules`)

A small, dependency-free package that is the single source of truth:

```ts
export const API_MODULES = {
  crm: {
    worker: 'crm-api',
    host: { production: 'crm-api.weldsuite.org', test: 'crm-api-test.weldsuite.org' },
    devPort: 8790,
    prefixes: ['/companies', '/people', '/person-companies', '/leads', /* … */],
  },
  // …
} as const;
```

Used by: the client host resolver, the app-api forwarder, the CI deploy matrix, CORS,
local dev, and an ownership test that scans `apps/workers/*/src/routes` and fails on
unowned or double-owned folders.

### 0.2 Shared kit: `packages/core/worker-kit` (`@weldsuite/worker-kit`)

Extracted from app-api, and app-api switches to it first (a pure refactor):

- `createModuleApi({ name, publicRoutes, routes })`: builds the Hono app with `requestId`,
  logger, CORS, `appContextMiddleware`, then `clerkMiddleware()` →
  `workspaceDbMiddleware()` → `featureFlagsMiddleware()` on `/api/*`, the JSON
  `notFound`/`onError`, and `initPermissionMiddleware`.
- Tenant DB resolution (`db/index.ts`, KV `WORKSPACE_CACHE` + master DB lookup).
- `lib/response`, `lib/id`, `lib/log-safe`, `lib/atomically`, `lib/entity-context`,
  `lib/cors-origins`, the realtime publishers, `custom-field-values`,
  `cloudflare-email`, `ai/billing`, `tenant-work-index`, `analytics-query`.
- `BaseEnv` type. Each worker extends it with only its own bindings. This removes the
  module imports from `types.ts`.
- Test harness: `createTestApp`, the pglite helpers, and the shared sweeps
  (`_event-coverage`, `_auth-gates`, `_list-endpoint-sweep`, `_app-permissions`),
  generalised to scan all module workers.

Also untangle the core → module imports listed above (internal routes, invitations/roles →
chat, search → ai billing, app-catalog → mail access, billing → internal email).

Set `CLERK_JWT_KEY` on every worker so token verification needs no JWKS fetch. With ~20
workers there are more cold isolates, and each would otherwise fetch the JWKS.

### 0.3 Client host routing

- `packages/clients/api-client`: `baseUrl` accepts `string | ((path: string) => string)`.
- `packages/clients/app-api-client`: `resolveApiBase(path)` uses the manifest prefixes and
  an **enabled-modules list**. Modules not on the list resolve to app-api, so an empty list
  behaves exactly like today.
- Platform: `lib/api/public-env.ts` gets `getModuleApiUrl(module)`, which derives
  `<m>-api(-test).weldsuite.org` from the SPA host like `getAppApiUrl()` does. The list
  comes from `VITE_API_MODULES` (with a runtime override from a feature flag, so a cutover
  can be reverted without a deploy).
- `lib/api/app-context-header.ts`: match any API origin from the manifest, not only the
  app-api base, so `X-Weld-App` keeps reaching module workers.
- Other transports that bypass the shared client (`weldbooks-client.ts`,
  `lib/documents/api.ts`, uploads, direct `fetch`) switch to the resolver.
- Mobile: `services/app-api.ts` in each app uses the same resolver.
  `EXPO_PUBLIC_API_MODULES` is set in `eas.json` and `deploy.yml`.
- Portals (`helpcenter`, `commerce-portal`, `hr-portal`): `APP_API_URL` per portal can
  point straight at desk-api / commerce-api / hr-api after cutover. Until then the
  forwarder covers them.

Auth already uses `Authorization: Bearer` (no cookies), so going cross-origin needs no
auth changes. Add `Access-Control-Max-Age` (e.g. 86400) to the kit's CORS config, because
every new origin means its own preflights.

### 0.4 Forwarder in app-api

A generic helper mounted **above** the `/api/*` auth guard, so the module worker does its
own auth:

```ts
for (const mod of enabledForwards(env)) {
  for (const prefix of mod.prefixes) {
    app.all(`/api${prefix}`, (c) => c.env[mod.binding].fetch(c.req.raw));
    app.all(`/api${prefix}/*`, (c) => c.env[mod.binding].fetch(c.req.raw));
  }
}
```

The request id is passed along in a header so logs across the hop correlate.

### 0.5 Scaffolder

A `pnpm create:module-api <module>` script (same idea as `create:mobile-app`). It
generates `apps/workers/<m>-api` with `package.json`, `wrangler.toml` (dev/test/production,
`custom_domain` routes, `WORKSPACE_CACHE`, `ENTITY_EVENTS`, `REALTIME`), `src/index.ts`
built on `createModuleApi`, and `vitest.config.ts`. It also adds the worker to the
secrets manifest and the CI matrix.

### 0.6 CI/CD

- `deploy.yml`: generate the per-worker path filters and the `ALL` list from the manifest
  instead of hand-maintaining 17+ entries. Changes to `worker-kit` or `api-modules`
  deploy every module worker, like `@weldsuite/db` changes already do.
- `ci.yml`: type-check, lint and tests per worker through turbo. **Do not rename existing
  required job names.** Add new jobs, or make one generic "workers" job that covers all
  of them.
- `scripts/secrets/manifest.ts`: one entry per worker, holding only the secrets it uses
  (least privilege is a side win: `WELDPASS_ROOT_KEY` only on pass-api, `TELNYX_*` only on
  call-api, and so on). Shared secrets: `DATABASE_URL_MASTER`, `NEON_API_KEY`,
  `DATABASE_ENCRYPTION_KEY*`, `CLERK_SECRET_KEY`, `CLERK_JWT_KEY`, `INTERNAL_API_SECRET`.
- DNS: `custom_domain = true` creates the records and certificates on first deploy
  (as for personal-api).

### 0.7 Local dev

- `pnpm dev:api` runs `wrangler dev -c apps/workers/app-api/wrangler.toml -c …/crm-api/wrangler.toml …`
  in one session. app-api gets the HTTP port; the others are reachable through service
  bindings, so the platform talks only to app-api and the forwarder routes. This is also
  why the forwarder stays after the migration.
- Working on one module: `pnpm --filter crm-api dev` on its `devPort`, with
  `VITE_API_MODULES=crm`.

## Phase 0: what shipped

Nothing changes for traffic until a module is enabled: no module worker exists yet,
`API_FORWARD_MODULES` and `VITE_API_MODULES` are unset, and app-api serves everything
exactly as before (all 1,428 app-api tests pass on the kit).

| Piece | Where | Notes |
|---|---|---|
| Module manifest | `packages/core/api-modules` | Prefixes, workers, bindings, dev ports (8801–8820), `findModuleForPath`, `createApiOriginResolver`. Its tests fail when an app-api mount has no owner, a module worker mounts another module's prefix, or an API worker imports from another worker folder. |
| Worker kit | `packages/core/worker-kit` | `createModuleApi` (request id, logger, CORS with a 1-day preflight cache, X-Weld-App, `/robots.txt`, `/health`, JSON notFound/onError, permission queries), `apiAuth()` (Clerk → tenant DB → flags), `db`, `response`, `id`, `log-safe`, `forward`, `testing` (the `createTestApp` harness), and the Workers bundling `shims/`. |
| app-api on the kit | `apps/workers/app-api` | `src/index.ts` uses `createModuleApi` + `apiAuth`; the old `lib/`, `middleware/`, `db/` and `test/harness.ts` files are re-exports, so the ~500 existing imports did not change. |
| Forwarder | `@weldsuite/worker-kit/forward` | First middleware in app-api. Forwards a path when its module is in `API_FORWARD_MODULES` **and** the `<MODULE>_API` service binding exists; otherwise app-api keeps serving it. |
| Client routing | `@weldsuite/api-client`, platform `lib/api/public-env.ts`, 11 mobile apps | `baseUrl` can be a per-path function. Platform: `VITE_API_MODULES` (+ optional `VITE_<MODULE>_API_URL`), `apiUrl()` / `getApiOriginForPath()` used by every direct `fetch`; the X-Weld-App header covers every API origin. Mobile: `EXPO_PUBLIC_API_MODULES`. |
| Scaffolder | `pnpm create:module-api <module>` | Generates the worker (wrangler config with custom domains, shared KV/queue/realtime/Flagship, smoke test) and its secrets-manifest entry. An empty worker bundles to ~1.2 MB raw / ~250 KB gzipped. |
| CI | `deploy.yml`, `ci.yml`, `.github/scripts/module-workers.mjs` | Module workers are picked from the manifest (their folder, the kit or the manifest changed) and, since phase 1, deploy in their own `module-workers` job **before** the other workers. Kit/manifest changes also redeploy app-api and OTA the mobile apps. The existing `Type Check · app-api` and `Unit · app-api` jobs now also check the kit, the manifest and every module worker (job names unchanged). |
| Local dev | `pnpm dev:api` | One `wrangler dev` session with app-api on 8789 and every module worker behind it; sets `API_FORWARD_MODULES` for local runs. |

Deferred from phase 0, on purpose:

- **Moving module-specific helpers into packages** (`cloudflare-email`, `ai/billing`,
  `tenant-work-index`, `analytics-query`, Sendcloud/Discord/Telnyx clients) and
  **untangling the core → module imports** (`routes/internal`, invitations/roles →
  chat, search → ai billing, app-catalog → mail access, `types.ts`). They pull in heavy
  packages (email, credits, AI, connectors), so putting them in the kit would make every
  worker bundle them. Each one moves in step 3 of the recipe, when the first module that
  needs it is extracted (e.g. `cloudflare-email` with hr or mail, `ai/billing` with books,
  `tenant-work-index` with flow).
- **The pglite test helper** stayed in app-api until a module worker needed it. It
  moved to `@weldsuite/worker-kit/testing/pglite` in phase 1.
- **A runtime switch for `VITE_API_MODULES`** (feature flag instead of build-time env).
  Reverting a cutover is a Pages redeploy for now.
- Portals (`helpcenter`, `commerce-portal`, `hr-portal`) and the developer portal keep
  calling app-api; the forwarder covers them until their module moves.

## Phase 1: pilot, WeldPass → `pass-api`

Why WeldPass: 14 files, no module edges in either direction, its own secrets and crypto,
and it is already exempt from entity events. It exercises the whole pipeline (kit,
scaffolder, secrets, custom domain, forwarder, client flag, CI) with the least code risk.

Exit criteria: pass-api serves production directly from the platform. Also measure
p50/p95 latency and cold starts against app-api, check that a pass-only change deploys
only pass-api, and turn the recipe below into a skill for the specialist agents.

### Phase 1: what shipped

- `apps/workers/pass-api` (scaffolded with `pnpm create:module-api pass`). WeldPass's
  `routes/weldpass` and `services/weldpass` moved there with `git mv`; the only
  import changes are `../../db`, `../../lib/*` and the test helpers → the kit. Its
  51 tests pass there, including the 19 route tests against pglite.
- app-api: `/api/weldpass` unmounted; `PASS_API` service binding (dev / test /
  production) and `API_FORWARD_MODULES = "pass"` in `[vars]`; `WELDPASS_ROOT_KEY*`
  dropped from its `Env`; the WeldPass exemption left `_event-coverage.test.ts`.
- Secrets manifest: `WELDPASS_ROOT_KEY` moved from `app-api` to `pass-api`, next to the
  kit's base secrets.
- Kit: the forwarder answers **503 `SERVICE_UNAVAILABLE`** when the module worker is
  unreachable (instead of a generic 500); the pglite helper moved into the kit.
- CI: module workers deploy in a `module-workers` job that the other workers wait for,
  so a PR can add a module worker and switch app-api to forward to it in one go.
- Verified locally with `pnpm dev:api`: `/api/weldpass` sent to app-api is answered by
  pass-api; with pass-api stopped, app-api answers 503 for it and still serves
  everything else. Both workers dry-run build for test and production (pass-api:
  1.65 MB raw / 326 KB gzip).

### Phase 1: rollout

1. **Before merging:** sync pass-api's secrets in test —
   `DOPPLER_TOKEN=… pnpm secrets:sync test pass-api`. `WELDPASS_ROOT_KEY` must be the
   same value app-api has, or existing vaults cannot be decrypted. If the sync fails
   because the pass-api worker does not exist yet, run it right after the first
   deploy; in between, WeldPass on test answers with its "root key is not configured"
   error (and requests fail auth without the Clerk/DB secrets).
2. Merge to `develop` → pass-api deploys to `pass-api-test.weldsuite.org`, then
   app-api-test starts forwarding `/api/weldpass`. Check the WeldPass screens on
   app-test (list, reveal, sync) and pass-api's logs.
3. Clients direct: set `VITE_API_MODULES=pass` for the test Pages build (and
   `EXPO_PUBLIC_API_MODULES=pass` for mobile OTAs, although no mobile app uses
   WeldPass today). The SPA then calls `pass-api-test` directly.
4. Production: same order (secrets sync production, merge to `main`, then
   `VITE_API_MODULES=pass` for the production Pages build).
5. Remove the now-unused `WELDPASS_ROOT_KEY` secret from app-api
   (`wrangler secret delete WELDPASS_ROOT_KEY --env <env>` in apps/workers/app-api)
   once production has run on pass-api for a while — it is the only copy on app-api,
   the Doppler value stays.

## Per-module extraction recipe (repeat for each module)

1. `pnpm create:module-api <m>` (the prefixes are already in the manifest; fix them there
   if the move shows they are wrong).
2. `git mv` the module's `routes/`, `services/`, `lib/`, `workflows/` and `cron/` files
   into the new worker, and point imports at the kit.
3. Resolve every remaining cross-module import with the rules above (kit / vendor package /
   direct read / RPC / event). Add the module's `<M>Rpc` entrypoint if others need it.
4. Move the tests; the shared sweeps must cover the new worker.
5. Non-HTTP work:
   - **Cron:** move the trigger to the new worker's `wrangler.toml`.
   - **Queues:** a queue has one consumer. Remove it from app-api and add it to the new
     worker in the same release. Messages wait in the queue during the gap.
   - **Workflows:** a workflow name belongs to one script, so give the moved class a new
     name (e.g. `send-digest-v3`). Keep the old class exported from app-api until its
     in-flight instances finish, then delete it.
6. app-api: unmount the routers, add the `<M>_API` service binding (dev/test/production)
   and add the module id to `API_FORWARD_MODULES` in its `[vars]`, in the same deploy.
   This can ship in the same PR as the new worker: deploy.yml deploys module workers
   before app-api, and a failed module deploy stops the app-api deploy.
7. Update server-to-server callers (bindings or URLs) that hit the module's paths.
8. Deploy to test → run the module's e2e specs → add the module to `VITE_API_MODULES`
   (platform) and `EXPO_PUBLIC_API_MODULES` (mobile) for test → production the same way.
9. After the mobile OTA with the new resolver has reached users (target: 60 days), and
   the forwarder logs show no traffic for the module, stop forwarding it in production.
10. Update docs: CLAUDE.md, the `backend-app-api` agent, and the module's specialist agent.

## Phase 2: wave A (isolated modules)

`host-api`, `social-api`, `ads-api`, `know-api`, `hr-api` (needs the portal middleware in
the kit), `stash-api` (needs the Sendcloud package), `data-api` (needs `CrmRpc`, or
`data-api` waits for crm-api).

Server callers to update in this wave: `integration-webhook-worker` and
`integration-sync-worker` call `/api/integrations/ad-*` (ads), which moves once connect
moves, so give them an `ADS_API` binding.

## Phase 3: wave B (core business modules)

`crm-api`, `books-api`, `commerce-api`, `calendar-api`, `meet-api`, `call-api`, `desk-api`,
`mail-api`. Each ships its RPC entrypoint for the edges pointing at it.

Server callers:
- `billing-worker` → `/api/internal/telephony/fulfill-number` moves to call-api.
- `workflow-worker` → `/api/internal/send-email` moves to mail-api (or stays core if we
  classify internal email as core).

## Phase 4: wave C (the tangled ones)

- `flow-api`: once `tenant-work-index` and `analytics-query` are in the kit, it is
  straightforward.
- `chat-api` and `agent-api` together, because of the ai ↔ chat cycle; the cycle is
  broken by the event/RPC split above.
- `connect-api` last. It has the most outbound edges (flow, ai, mail, books, crm, desk,
  ads) and the most external callers (`integration-webhook-worker`,
  `integration-sync-worker` via `APP_API`, `workflow-worker` via
  `/api/internal/workflow-actions/*`).

## Phase 5: finish

- app-api contains only the core. `/api/internal` keeps only the core internal routes.
- The forwarder stays for local dev and old clients, but is off in production except for
  prefixes that still show traffic.
- Update CLAUDE.md ("app-api is the only backend" becomes "app-api is core; modules have
  their own `<m>-api` workers"), the `backend-app-api` and `backend-workers` agent
  definitions, and the `/fix-bug` / `/feature` routing, so agents open the right worker.

## Out of scope

- `external-api` and `mcp-server` keep their own routes. Later they could call module RPCs
  instead of duplicating services, but that is a separate project.
- Splitting the database or the Drizzle schema.
- Frontend changes beyond host routing. The modules stay in the platform SPA.

## Risks and costs

| Risk | Mitigation |
|---|---|
| ~20 workers to deploy, monitor and keep secrets for | manifest-driven CI and secrets, scaffolder, kit; merge very small modules (ads, know, pass) later if they are not worth their own worker |
| Kit changes redeploy everything | keep the kit small and stable; module code never goes into it |
| Cross-module writes lose atomicity over RPC | find them per module (step 3); keep the write in one module or use events with idempotent consumers |
| Old clients calling moved paths | forwarder in app-api until traffic is zero |
| More origins → more DNS/TLS/preflight | preflight caching (`Access-Control-Max-Age`); all hosts are on the same Cloudflare zone |
| Workflow instances in flight during a move | new workflow names; old class kept until drained |
| Tests assume one routes folder | shared sweeps in the kit, driven by the manifest |

## Success measures

- A change inside one module deploys only that module's worker (check in the deploy logs).
- Each module worker bundle is a fraction of today's 11.1 MB raw / 1.81 MB gzipped.
- p95 latency and cold-start time per module are no worse than app-api today.
- The boundary lint rule and the ownership test pass with no exceptions.

## Decisions still open (defaults in brackets)

1. Keep the core worker named `app-api` on `app-api.weldsuite.org`. [yes]
2. Drive, custom objects, search and notifications stay in core. [yes, other modules depend on them]
3. Calendar separate from Meet, Know separate from Desk, Call separate from Desk, following
   the platform folders. [yes]
4. Internal email (`/api/internal/send-email`): core or mail-api. [core]
5. Forwarder retention before turning a prefix off in production. [60 days + zero traffic]
