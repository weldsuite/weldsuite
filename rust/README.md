# WeldSuite Rust backend

The backend for the Kubernetes deployments, the EU and self-hosted editions
(ADR API-014). It builds one binary, `weldsuite`, shipped as one container image
(linux/amd64 and arm64) and installed with the Helm chart in
`deploy/helm/weldsuite`. The Global edition keeps the TypeScript workers on
Cloudflare; modules are ported from them one at a time, and both
implementations answer the same API, checked by the conformance suite. The
design, the decisions and the phase plan live in the private docs repo:
`design/platform/editions-and-self-hosting.md` and
`editions-and-self-hosting-phases.md` in `weldsuite/weldsuite-documentation`.

Status (2026-10-31): **P1 (foundations), P2 (conformance suite), P3 (pilot
modules) and P4's backend (core platform) done, and P6's EU launch set
ported; P5 (infrastructure) is being proven on the EU test cluster.**
`weldsuite serve` runs the full request pipeline (session token → workspace →
tenant database → licence and read-only → feature flags → permission →
envelope) with entity events, realtime and cache behind ports;
`weldsuite consume` runs the event subscribers on NATS JetStream, and
`weldsuite migrate` and `weldsuite cron <job>` the migrations and the
scheduled jobs. `RUST_PORTED_MODULES` (`@weldsuite/api-modules`) has seventeen
modules, each with conformance suites that reach every route:

- **core**: everything app-api serves except `/api/billing` (Stripe stays
  Global-only), `/api/partner` and `/public/partner-territories` (the partner
  portal) and `/api/internal` (staff); signup and provisioning on Zitadel and
  CloudNativePG (`/api/onboarding`, `workspace.provision`)
- **know**, **sign** (member side, lifecycle, `sign.finalize`, the signer
  portal's operations at `/public/sign-portal`, ADR FE-017), **pass**,
  **calendar**, **crm**, **flow**, **mail** (and its inbound path: Haraka
  as the MX, the `mail.inbound` subscriber in place of mail-inbound-worker,
  ADR MAIL-010, see "Inbound mail" below), **chat**, **desk** (with the
  helpdesk widget API at `/public/helpdesk-widget`, and the helpdesk
  workflow engine, `helpdesk-workflow-worker`, in process: its
  `ConversationWorkflow` is the `desk.conversation-workflow` job and its
  `AssignmentRouter` keeps each workspace's round robin on Valkey;
  `crates/desk-domain/src/workflow`) and **stash** (the WMS, with the
  pick-list ship action's Sendcloud announcement over outbound HTTP)
- **ads** (WeldAds: Meta connections, ad accounts and campaigns, synced
  with Meta's Marketing API through the outbound HTTP port; the shared sync
  code is `crates/ads-domain`, for connect-api's integration endpoints
  when they are ported)
- **social** (WeldSocial: accounts, posts, campaigns, media, approvals, team,
  settings and analytics, publishing through PostPeer's API with the
  prepaid-credit metering, and PostPeer's delivery webhook at
  `/public/social/postpeer/webhook`; the publishing service is
  `crates/social-domain`, for external-api and mcp-server when they are
  ported)
- **data** (WeldData: the Lemlist lead database search with its cache,
  lists and saved leads, converting leads into CRM people and companies and
  onto CRM lists, enrichment columns and cells, the enrich field definitions
  and enrichment views; a column run is the `data.welddata-enrich` job,
  the `WELDDATA_ENRICH` Workflow: Findymail or Prospeo for emails through
  the outbound HTTP port, the company's own website for phone numbers, read
  on public addresses only, and the AI action stubbed as on Global)
- **hr** (WeldHR: the employee directory, departments, client assignments,
  on- and offboarding, shifts, attendance, leave, open shifts and shift
  requests, work locations, expense declarations, sick reports,
  announcements, coaching, evaluations, KPIs and milestones, My HR, and
  payroll behind the `weldhr-payroll` flag: employers, schedules, employee
  pay, runs, payslip PDFs, SEPA and NACHA files, the loonaangifte, US forms,
  corrections, annual statements and the WeldBooks journal; the Dutch and US
  engines are `crates/payroll-domain`, checked against vectors the
  TypeScript engines write, `pnpm rust:payroll-fixtures`)
- **commerce** (WeldCommerce: products and their sales channels on
  WooCommerce, Shopify and Picqer, categories, orders with WeldBooks' manual
  sales tax engine, parcels, shipments, pickups, returns, shipping rules and
  prices, carriers, parcel analytics, rates, settings, wallet and
  notifications, Sendcloud and PrintNode, and the B2B order portal: its staff
  routes and the public portal at `/public/commerce-portal`, with the
  sign-in limits on the cache's atomic counters and the sign-in mail as
  system mail; `crates/commerce-domain` holds the portal's tokens, slugs and
  limits. Not yet: the Stripe Tax and Avalara engines (an order an entity on
  one of them taxes answers 503, never zero tax), the portal's invoice
  document (503 until WeldBooks' invoice generator is ported) and
  WooCommerce's app-auth callback, which completes a WeldConnect
  authorisation)
- **call** (WeldCall, telephony on Telnyx: calls and their prepaid minutes,
  call intelligence (phone numbers, the WebRTC token, statistics, call
  transcriptions), the WeldDesk phone channel's voice agents (Telnyx AI
  assistants) and inbound routes, number porting with its documents in the
  `STORAGE` bucket, telephony (searching and syncing the account's numbers,
  addresses, ordering requirements, the price list), and the Telnyx webhook
  at `/public/webhooks/telnyx`, its Ed25519 signatures checked as on Global:
  porting events, inbound calls routed by the dialled number into a WeldDesk
  phone conversation, call events, the live AI transcript, and the voice
  agent's `lookup_crm` tool. Telnyx is called through the outbound HTTP port.
  Buying a number and submitting a port are Stripe checkouts through Global's
  billing-worker: they answer as when billing-worker cannot be reached, and
  billing-worker's fulfilment callback (`/api/internal/telephony`) as without
  Stripe. Not yet: marking the desk SLA due on an inbound call, which waits
  for `crates/desk-domain` to gain the SLA engine)

Features this backend lacks inside the modules it serves are listed in
`/config.json` as `unavailableFeatures` (`bins/weldsuite/src/edition.rs`), so
the platform hides them: SSO connections, billing, credit top-up, paid apps,
desktop sign-in, analytics, search reindex, company logos, mail domains, free
`weldmail.com` addresses, mail AI, chat calls, help center custom domains,
sending the loonaangifte over Digipoort, WeldBooks document OCR and buying
or porting phone numbers.
Routes left out on purpose are in their suite's `excludedRoutes`, with the
reason. Not ported yet (P8): books,
host, meet, connect, agent, reach, sheets, docs and
panel, and the edge workers (`external-api`, `mcp-server`, the integration
workers).

## Layout

```
rust/
  Cargo.toml            workspace: shared package metadata, lints, dependency versions
  rust-toolchain.toml   pinned compiler (CI and local builds use the same one)
  deny.toml             cargo-deny: allowed licences, advisories, sources
  clippy.toml           clippy settings (product names allowed in docs)
  .cargo/config.toml    build settings (prebuilt NASM for aws-lc on Windows)
  catalogs/*.json       generated by `pnpm rust:catalogs` from the TypeScript catalogs; don't edit
  catalogs/emails/      generated by `pnpm rust:emails`: the system email templates as minijinja; don't edit
  conformance/          suites.json: the worker tests each ported route must pass (P2)
  docs/spikes.md        the answers to spikes S3 (PgBouncer) and S4 (thousands of tenants)
  Dockerfile            the image (distroless, nonroot, cross-compiled for arm64) with the platform SPA; context is the repo root
  bins/weldsuite/       the one binary: `serve` (routes/, infra.rs, conformance.rs), `consume` (consume/), `cron <job>` (cron.rs), `migrate` (migrate.rs)
  crates/kit/           envelope, errors, ids, CORS, request id, pagination, cursors, zod-shaped validation
  crates/catalogs/      entity events, permission keys, flags, API modules (+ Rust flag), origins
  crates/auth/          session tokens: Clerk's or an OIDC provider's (Zitadel; discovery, fetched JWKS), step-up second factor
  crates/permissions/   @weldsuite/permissions: matching, per-app checks, grants, resolution, route layer
  crates/db/            master DB, workspace → tenant pool, database_url sealing and opening, Postgres errors,
                        atomically, Drizzle-shaped rows, permission lookups
  crates/migrations/    the journaled Drizzle migrations, embedded at build time, and the runner behind
                        `weldsuite migrate` (the TypeScript runners' twin; see "Migrations" below)
  crates/pipeline/      the gates after auth: licence, read-only, app access, feature flags
  crates/ports/         ports (cache, event bus, realtime, flags, files, jobs, system mail, identity, database provisioning),
                        their test doubles, in-process jobs
  crates/events/        @weldsuite/entity-events: the hub message and the fire-and-forget publisher
  crates/subscribers/   the hub subscribers `consume` runs: audit log, search index, outgoing webhooks, realtime;
                        tests/fixtures from `pnpm rust:subscriber-fixtures` (the TypeScript consumers on pglite)
  crates/mail-inbound/  mail-inbound-worker's port (MAIL-010): postal-mime's parser, the Authentication-Results read,
                        spam and promotion scoring, thread matching, the registry lookup, the Postgres mailbox store's
                        ingest, mail rules, notifications, the WeldDesk and WeldBooks inboxes; the `RCPT TO` check
                        `serve` answers and the `mail.inbound` subscriber `consume` runs; tests/fixtures from
                        `pnpm rust:mail-inbound-fixtures` (the worker's own code, on pglite where it writes)
  crates/adapters-oss/  open-source adapters: Valkey cache + pub/sub, NATS JetStream, Restate jobs, flags in the master DB,
                        files over the S3 API, system mail over SMTP, identity on Zitadel, workspace databases on
                        CloudNativePG shards; `realtime.rs` is the realtime backplane's wire format on Valkey (stamped
                        events, replay log, presence)
  crates/realtime/      the realtime WebSocket gateway in `serve` (the realtime-worker's hubs and rooms, every pod,
                        Valkey between them); mounted by bins/weldsuite/src/realtime.rs
  crates/emails/        @weldsuite/emails: the exported templates rendered with minijinja, sendSystemEmail
  crates/desk-domain/   WeldDesk rules the desk modules share: webchat, assignment and the AssignmentRouter,
                        the helpdesk workflow engine (`workflow/`: handlers, the desk.conversation-workflow job);
                        tests/fixtures from `pnpm rust:desk-workflow-fixtures` (helpdesk-workflow-worker on pglite)
  modules/<module>/     one crate per ported weld* module, mounted at its path prefix once
                        `RUST_PORTED_MODULES` has it (conformance builds mount all): modules/know,
                        modules/sign, modules/pass, modules/calendar, modules/crm, modules/flow,
                        modules/mail, modules/chat, modules/desk, modules/desk-widget (the
                        helpdesk widget API, at /public/helpdesk-widget), modules/stash (the WMS),
                        modules/ads (with
                        crates/ads-domain: Meta's API, the campaign sync, the ad sync index),
                        modules/social (with crates/social-domain: PostPeer publishing, credits),
                        modules/data (WeldData, and the welddata-enrich job),
                        modules/commerce (with crates/commerce-domain: the order portal's tokens,
                        slugs and rate limits),
                        modules/hr (WeldHR and payroll, with crates/payroll-domain: the
                        Dutch and US engines, SEPA, NACHA, the loonaangifte, US forms, PDFs),
                        modules/call (WeldCall: Telnyx, the webhook);
                        core is split over
                        modules/core-files (app-api files, folders, drive, search, storage),
                        modules/core-objects (WeldObjects, custom fields, object templates, grid views),
                        modules/core-team (team, roles, settings, preferences, app catalog),
                        modules/core-platform (notifications, audit logs, appstore, API keys, credits,
                        dashboard, support, SSO, auth sessions), modules/core-apps (WeldApps and its
                        gateway, the CLI and desktop sign-in routes), modules/core-onboarding (signup:
                        /api/onboarding, the workspace.provision job, the identity sync, the deletion sweeps)
  deploy/helm/weldsuite the Helm chart
  deploy/haraka/        the MX image (MAIL-010): Haraka with three plugins, the RCPT TO check, DMARC + Authentication-Results,
                        and the hand-off to the mail bucket and NATS
  deploy/kind/          the kind smoke test: Postgres (migrated by the chart's Job), Valkey, NATS, RustFS (S3), Restate, the chart, a signed request, a job, a message over SMTP
  deploy/hetzner/       OpenTofu for the EU cluster on Hetzner (Talos), the runbook and the monthly drill
  deploy/flux/          Flux GitOps for that cluster: CloudNativePG, NATS, Valkey, Restate, Zitadel, the app
  deploy/validate.sh    checks the two above without a cloud account (CI: Rust · deploy config)
```

## Commands

From the repo root:

```bash
pnpm rust:catalogs     # re-export rust/catalogs/ (and the permission parity cases) from TypeScript
pnpm rust:emails       # re-export the system email templates (rust/catalogs/emails) and their render cases
pnpm rust:fmt          # format
pnpm rust:lint         # rustfmt --check + clippy, warnings are errors
pnpm rust:test         # tests
pnpm rust:deny         # licences, advisories, duplicate crates, sources (needs cargo-deny)
pnpm rust:conformance  # the worker tests of every ported route, against Rust (report in rust/target/conformance)
pnpm rust:subscriber-fixtures   # re-export what the TypeScript hub consumers do, for crates/subscribers/tests/parity.rs
pnpm rust:payroll-fixtures      # re-export the payroll rule tables and the engines' vectors, for crates/payroll-domain
pnpm rust:desk-workflow-fixtures   # re-export what helpdesk-workflow-worker does, for crates/desk-domain/tests/workflow_parity.rs
pnpm rust:mail-inbound-fixtures # re-export what mail-inbound-worker does, for crates/mail-inbound/tests/parity.rs
pnpm rust:conformance --coverage apps/workers/know-api   # which routes a worker's own tests reach
pnpm exec tsx scripts/rust-realtime-parity.ts --bin rust/target/debug/weldsuite \
  --pg postgres://…/postgres --valkey redis://…   # the realtime gateway vs @weldsuite/realtime's clients, two pods
```

Or `cargo …` inside `rust/`. The pinned toolchain installs itself through rustup
on first use; `cargo install cargo-deny --locked` for the deny check.

The integration tests need throwaway services and are skipped without them:

| Variable | Service | Tests |
|---|---|---|
| `WELDSUITE_TEST_DATABASE_URL` | Postgres (a scratch database; its role creates databases for `weldsuite-migrations` and the CloudNativePG provisioner) | `weldsuite-db`, the flag table, the migration runner, the provisioner |
| `WELDSUITE_TEST_MASTER_URL`, `WELDSUITE_TEST_TENANT_URL` | Postgres with pgvector, built by `pnpm exec tsx scripts/rust-test-db.ts` from the journaled migrations | the SQL against the real schema |
| `WELDSUITE_TEST_VALKEY_URL` | Valkey (`redis://…`) | cache and pub/sub adapters |
| `WELDSUITE_TEST_NATS_URL` | NATS with JetStream (`nats://…`) | event bus adapter; with the tenant URL, the consume end-to-end test |
| `WELDSUITE_TEST_S3_ENDPOINT` (+ `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`) | an S3 store, e.g. `docker run -p 9000:9000 rustfs/rustfs:1.0.1` | S3 file store |
| `WELDSUITE_TEST_RESTATE_INGRESS`, `_ADMIN`, `_ENDPOINT_HOST` | a Restate server, e.g. `docker run -p 8080:8080 -p 9070:9070 --add-host=host.docker.internal:host-gateway restatedev/restate:1.7.14`, with `host.docker.internal` as the host it reaches the test on | Restate jobs adapter |
| `WELDSUITE_TEST_SMTP_URL` | an SMTP server, e.g. `docker run -p 1025:1025 axllent/mailpit:v1.31.6` (`smtp://127.0.0.1:1025`) | SMTP mail |

CI (`Rust · checks`) starts all of them.

## Conformance (P2)

`pnpm rust:conformance` builds `weldsuite` with the test-only `conformance`
feature and runs the test files in `conformance/suites.json` with
`CONFORMANCE_TARGET=rust`: every `createTestApp().request()` goes to the Rust
server and to the Hono app, and the status, the JSON (ids, timestamps and
cursors normalised for writes), the route's Zod schema and the side effects
(entity events, realtime publishes) must all match. The test's pglite database
is served to Rust over the wire, so both read the same rows. Details:
`packages/core/worker-kit/src/testing/conformance.ts`.

A module counts as ported when its suites pass with every route covered; then
its id goes into `RUST_PORTED_MODULES` (`@weldsuite/api-modules`), the server
mounts it, and its suite becomes part of the parity gate: CI runs it on every
PR that touches the module, so a feature lands in both backends.

## Migrations

`weldsuite migrate` applies the journaled Drizzle SQL
(`packages/core/db/drizzle/{master,tenant}-migrations`) to the master database
and to every active workspace's tenant database. `crates/migrations/build.rs`
embeds the SQL in the binary, so an image carries exactly the migrations its
code was built for and needs no Node (the image build copies their SQL and
journals from the repo root, its context; `rust/Dockerfile.dockerignore`
leaves the snapshots out). It is the TypeScript runners' twin: the master as
`pnpm db:migrate:master` does it (`drizzle.__drizzle_migrations`), each tenant
as `apps/tools/migrate-databases` does it (`public.__drizzle_migrations`), with
the same rows, the same one-transaction run, the same tenant selection and
move skipping, `--dry-run`, `--only <id>`, `--check-journal` and
`--apply-skipped`; a database either runner migrated is up to date for the
other. Additions: `--concurrency <n>`, and a transaction-scoped advisory lock
so two Rust runners on one database take turns. The Helm chart runs it as a
`pre-install,pre-upgrade` hook Job with the server's image, Secret and
environment (`migrations.*` values), so pods of a release only start on a
schema that release was built for; the kind smoke test builds its databases
that way.

```bash
DATABASE_URL_MASTER=postgres://… DATABASE_ENCRYPTION_KEY_V2=… weldsuite migrate --dry-run
weldsuite migrate --master --tenants --concurrency 4
weldsuite migrate --tenants --only ws_123 --check-journal
```

## Running it

```bash
docker build -f rust/Dockerfile -t weldsuite:dev .                                       # from the repo root: the server and the platform SPA
docker build -f rust/Dockerfile --target sign-portal -t weldsuite-sign-portal:dev .     # the WeldSign signer portal (Node, ADR FE-017)
docker build -t weldsuite-haraka:dev rust/deploy/haraka                                # the MX (MAIL-010)
rust/deploy/kind/smoke-test.sh     # kind + Postgres + Valkey + NATS + RustFS + Restate + the chart; a signed request through the pipeline, a job through Restate, the SPA, the portal, inbound mail over SMTP
```

The image carries the platform SPA, built with `VITE_RUNTIME_CONFIG=on`, in
`/srv/spa`, and the server serves it for every path its routes don't answer
(`bins/weldsuite/src/spa.rs`): `index.html` for client routes (revalidated),
hashed `/assets/*` cached for a year and precompressed (`.br`, `.gz`), the
build's `_headers` rules, a 404 for a missing asset. `/api`, `/public`,
`/config.json` and the probes keep precedence, so the platform and its API
share one origin and the app finds the API through `/config.json`
(`"backend": "rust"`). The build context is the repo root, trimmed by
`rust/Dockerfile.dockerignore`.

`weldsuite cron <job>` runs one scheduled job and exits, with the same
environment (the chart's CronJobs, `cron.jobs` in its values): `sign-lifecycle`
every 15 minutes, `identity-sync` every minute (the identity provider's
changes into the databases, what Clerk's webhooks do on Global),
`workspace-deletion` daily and `workspace-teardown` hourly. The server reads environment variables only (`bins/weldsuite/src/config.rs`):

| Variable | |
|---|---|
| `DATABASE_URL_MASTER` | master database (required) |
| `AUTH_PROVIDER` | `clerk` (default) or `oidc` (ADR SEC-012) |
| `CLERK_JWT_KEY`, `CLERK_JWKS_FILE`, `CLERK_JWKS_URL` or `CLERK_SECRET_KEY` | with `clerk`: session token keys: a PEM, a JWKS file, a JWKS URL, or Clerk's Backend API (one is required) |
| `OIDC_ISSUER`, `OIDC_AUDIENCE` | with `oidc` (both required): the issuer (`iss`, and where discovery reads `/.well-known/openid-configuration`) and the accepted audiences, comma separated (Zitadel: the project id) |
| `OIDC_ORG_CLAIM` | the claim naming the session's organization (default `urn:zitadel:iam:org:id`; Zitadel's project-roles claim works too). Its value is matched against `workspaces.clerk_org_id`, which holds the provider's organization id on Kubernetes, or `workspaces.id` |
| `OIDC_JWKS_URL`, `OIDC_WEB_CLIENT_ID` | fetch the keys here instead of through discovery; the platform's PKCE client id for `/config.json` (both optional) |
| `DATABASE_ENCRYPTION_KEY`, `DATABASE_ENCRYPTION_KEY_V2` | open encrypted `workspaces.database_url`; open the Sendcloud secret a workspace stored for WeldStash's ship action; seal and open WeldAds' Meta tokens (`encryptField`); open WeldCommerce's store connection, Sendcloud and sales tax engine credentials |
| `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_SIP_CONNECTION_ID`, `TELNYX_PUBLIC_KEY` | WeldCall: Telnyx's API key (unset: the phone service is not activated), the Call Control connection numbers are synced from and the WebRTC credential connection, and the account's Ed25519 public key `/public/webhooks/telnyx` checks every webhook with (unset: every webhook is refused, 401). The voice agent's tool tokens are signed with the API key |
| `APP_API_PUBLIC_URL` | WeldDesk and WeldCall: this server's public base URL, for the URLs a third party calls back on (OAuth redirects, the voice agent's `lookup_crm` tool); by `ENVIRONMENT` otherwise |
| `COMMERCE_PORTAL_URL` | WeldCommerce: the B2B order portal's origin, for the links in its sign-in mail and the portal URL its settings show (default by `ENVIRONMENT`: `https://orders.weldsuite.org` in production, `https://orders-test.weldsuite.org` in test, else `http://localhost:3021`) |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | WeldAds: the Meta app ad connections authorize (unset: connecting answers 500 `Facebook OAuth is not configured`); the OAuth callback page is on `PUBLIC_APP_URL` (default `https://app.weldsuite.org`). The OAuth state lives in Valkey, or in this process without it |
| `POSTPEER_API_KEY`, `POSTPEER_BASE_URL`, `POSTPEER_APP_IDS`, `POSTPEER_WEBHOOK_SECRET` | WeldSocial: PostPeer's API key (unset: connecting and publishing answer 400 `Social publishing is not configured`), its base URL (default `https://api.postpeer.dev/v1`), the BYOK OAuth apps as a JSON object of platform → app id, and the secret PostPeer signs its delivery webhooks with (unset: every delivery is refused). Publishing charges the workspace's prepaid credits (2 per platform) |
| `LEMLIST_API_KEY` | WeldData: the shared Lemlist key for the lead database (unset: searches and the filter catalog answer 500 `Lead database is not configured`). Search pages and the catalog are cached in Valkey when it is set |
| `FINDYMAIL_API_KEY`, `PROSPEO_API_KEY` | WeldData: the email finder's providers, read by the `data.welddata-enrich` job (unset: the cells of that provider fail with `… is not configured`) |
| `CLERK_AUTHORIZED_PARTIES` | extra origins allowed as `azp` |
| `PERMISSIONS_APP_ENFORCE` | `true` refuses per-app denials instead of logging them |
| `VALKEY_URL`, `VALKEY_CACHE_PREFIX`, `VALKEY_REALTIME_PREFIX` | cache, realtime publish and the WebSocket gateway (optional; without it, upload tokens live in the server process, enough for one replica only, and the gateway is off) |
| `REALTIME_PUBLIC_URL` | the gateway URL `/config.json` gives the frontends (default: the request's own origin with `/ws`) |
| `REALTIME_MAX_CONNECTIONS`, `REALTIME_MAX_CONNECTIONS_PER_USER`, `REALTIME_MAX_SUBSCRIPTIONS`, `REALTIME_MAX_MESSAGE_BYTES`, `REALTIME_SEND_QUEUE` | gateway limits per pod (20,000 sockets, 100 per person, 2,000 topics per socket, 1 MiB messages, 1,024 queued messages before a slow client is dropped) |
| `REALTIME_INTERNAL_SECRET` | `x-internal-secret` of `/publish/*` and `/internal/presence` (optional; unset refuses them) |
| `VALKEY_DESK_ASSIGNMENT_PREFIX` | WeldDesk: where the `AssignmentRouter` keeps each workspace's rotation and recent picks on Valkey (default `weldsuite:desk-assignment:`), so auto-assignment's round robin holds across pods. Without `VALKEY_URL` they live in the server process (one replica's worth) |
| `DISCORD_BOT_TOKEN` | WeldDesk: the bot a helpdesk workflow posts its messages to a Discord conversation with (optional; unset: nothing is posted, as on Global without it). Slack conversations use the bot token of the workspace's Slack integration |
| `WIDGET_TOKEN_SECRET` | WeldDesk: the helpdesk widget API (`/public/helpdesk-widget`) signs its visitors' conversation-room tokens with it and the gateway verifies them, the workers' value (optional; unset: `POST /api/realtime/token` answers 500 and visitors get no live updates) |
| `NATS_URL`, `NATS_USER`/`NATS_PASSWORD` or `NATS_TOKEN`, `NATS_ENTITY_EVENTS_STREAM`, `NATS_ENTITY_EVENTS_SUBJECT`, `NATS_ENSURE_STREAMS` | entity events (optional) |
| `SMTP_URL` | system mail: `smtp://user:password@relay:587?tls=required`, `smtps://…:465` or `smtp://mailpit:1025` (optional; unset skips mail, as the workers without `SEND_EMAIL`) |
| `SYSTEM_EMAIL_FROM` | send from this address instead of `notifications@mail.weldsuite.org` (optional) |
| `SIGN_SESSION_SECRET`, `SIGN_PORTAL_URL` | WeldSign: the key of signer sessions and access-code hashes (the workers' value), and the signer portal's origin for signing links (default `https://sign.weldsuite.org`) |
| `WELDPASS_ROOT_KEY`, `WELDPASS_ROOT_KEY_V2` | WeldPass: the root key that wraps every vault's key (64 hex characters, the workers' value, so either backend opens the other's vaults), and the new one while a rotation is in flight. Unset: the vault routes answer 500 `CRYPTO_ERROR`. Losing it makes every stored secret unrecoverable |
| `SIGN_PORTAL_SECRET` | WeldSign: the key the signer portal sends with every call to `/public/sign-portal` (ADR FE-017); unset refuses those calls (503) |
| `MAIL_INBOUND_SECRET` | WeldMail: the key Haraka sends (`Authorization: Bearer`) with the `RCPT TO` check, `POST /internal/mail-inbound/recipients` (MAIL-010); unset refuses it (503, Haraka answers 451) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_PRIVATE`, `S3_BUCKET_PUBLIC`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | files: the private bucket and the legacy public one (optional; any S3 store: RustFS, Garage, Ceph RGW, Hetzner, AWS) |
| `RESTATE_INGRESS_URL`, `RESTATE_ADMIN_URL`, `RESTATE_DEPLOYMENT_URI`, `JOBS_PORT` | durable jobs on Restate: start through the ingress; each pod serves the jobs service on `JOBS_PORT` (9080) and registers `RESTATE_DEPLOYMENT_URI` with the admin API at start. Unset: jobs run in the server process and a restart loses them |
| `S3_PUBLIC_URL` | the public bucket's own URL (the workers' `R2_PUBLIC_URL`), for Drive rows that store only a key (optional) |
| `STORAGE_SIGNING_KEY` | signs the files cookie and the signed URLs that open private objects (`/api/storage`); the same value as app-api's, so either backend accepts the other's. Unset: `POST /api/storage/access` and `/sign` answer 503, and a private object opens only with a session token |
| `ZITADEL_API_URL`, `ZITADEL_SERVICE_TOKEN`, `ZITADEL_PROJECT_ID`, `ZITADEL_HOST`, `ZITADEL_INVITE_URL_TEMPLATE` | the identity provider's management API (`crates/adapters-oss/src/zitadel.rs`): a service user's token (`IAM_OWNER`), the WeldSuite project, the `Host` for an in-cluster URL, the invite link (optional; unset: no identity provider) |
| `TENANT_SHARDS`, `TENANT_REGION`, `FIELD_ENCRYPTION_AAD_WRITES` | new workspace databases on CloudNativePG shards (a JSON list, `crates/adapters-oss/src/cnpg.rs`), their region, and sealing their URLs as v3. With shards and Zitadel set the server serves `/api/onboarding` and runs `workspace.provision` (optional) |
| `PARTNER_PORTAL_URL` | the reseller portal named in a territory request's email (default `https://partner.weldsuite.org`) |
| `SPA_DIR` | serve the built SPA in this directory for every path the routes don't answer; the image sets `/srv/spa`, empty serves the API alone |
| `EDITION`, `PUBLIC_ENV` | edition flags in `/config.json` (`bins/weldsuite/src/edition.rs`): `self-hosted` (default) or `eu`, and a JSON object of public platform settings by their `VITE_*` name (only the names in `PUBLIC_ENV_KEYS`; any other stops the start). The modules offered (`RUST_PORTED_MODULES`) and the features this backend lacks (`UNAVAILABLE_FEATURES`) follow the code |
| `EXTERNAL_API_URL`, `USER_APP_BUNDLE_SIGNING_KEY` (else `INTERNAL_API_SECRET`), `USER_APP_BUNDLE_ORIGIN`, `USER_APP_FRAME_ANCESTORS`, `WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS` | WeldApps: where the app gateway forwards to (external-api), the bundle-link signing secret (the same value as app-api's, so links open on either backend), the dedicated bundle origin, extra `frame-ancestors`, and the workspaces whose apps are first-party (all optional; without a signing secret, private bundles fail closed) |
| `FEATURE_FLAGS` (`defaults`/`master-db`), `FEATURE_FLAGS_REFRESH_SECONDS` | where flag values come from |
| `TEST_FIXTURES_TOKEN` | unlocks `X-Test-Flags` in `development`/`test` |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` | export traces over OTLP/HTTP (optional) |
| `PORT`, `HOST` | listen address (default `0.0.0.0:8080`) |
| `TRUSTED_PROXIES` | how many proxies in front of the server append to `X-Forwarded-For` (default 1, the ingress controller; 2 with a CDN the ingress trusts): the client's address, which the helpdesk widget's rate limit keys on, is that many entries from the right. `CF-Connecting-IP` is not trusted on Kubernetes |
| `ENVIRONMENT`, `LOG_FORMAT` (`json`/`text`), `RUST_LOG` | reporting and logs |
| `DATABASE_MASTER_MAX_CONNECTIONS`, `TENANT_POOL_MAX_CONNECTIONS`, `TENANT_POOLS_MAX`, `WORKSPACE_CACHE_TTL_SECONDS` | pools and the workspace cache |
| `SHUTDOWN_DELAY_SECONDS` | how long `/readyz` fails after SIGTERM before connections stop |

`weldsuite consume` runs the entity-event subscribers on NATS JetStream: one durable
consumer per subscriber on the hub stream, retries with backoff, a dead-letter
stream. It reads the same database, NATS and Valkey variables, needs no sign-in
settings, and has its own (`CONSUME_SUBSCRIBERS`, `NATS_STREAM_REPLICAS`, `NATS_STREAM_MAX_BYTES`,
`NATS_DEAD_LETTER_MAX_BYTES`,
`NATS_DEAD_LETTER_STREAM`, `EMBEDDINGS_URL`/`EMBEDDINGS_MODEL`/`EMBEDDINGS_API_KEY`,
`WEBHOOK_ALLOW_PRIVATE_NETWORKS`, `WEBHOOK_RETRY_SWEEP`, `CONSUME_DRAIN_SECONDS`):
the list and the stream layout are in `bins/weldsuite/src/consume/`.
With `S3_BUCKET_MAIL` set it also runs `mail-inbound` (in the default list then;
named in `CONSUME_SUBSCRIBERS` it needs the bucket), on its own stream:
`S3_BUCKET_MAIL` on `S3_ENDPOINT` (the keys and `S3_FORCE_PATH_STYLE` as for
files), `S3_BUCKET_PUBLIC` and `R2_PUBLIC_URL` (else `S3_PUBLIC_URL`) for
attachments and avatars, `NATS_MAIL_INBOUND_STREAM`/`_SUBJECT`/`_DLQ_STREAM`
(`MAIL_INBOUND` on `mail.inbound`, dead letters in `MAIL_INBOUND_DLQ`).

## Inbound mail

On Global, Cloudflare Email Routing hands each message to
`apps/workers/mail-inbound-worker`. On Kubernetes (ADR MAIL-010):

1. **Haraka** (`deploy/haraka`, the chart's `mailInbound`, off by default) is
   the MX behind a load balancer on port 25, with the PROXY protocol and
   STARTTLS (a cert-manager certificate). At `RCPT TO` it asks `serve`
   (`/internal/mail-inbound/recipients`, `MAIL_INBOUND_SECRET`): the master
   registry (MAIL-002), the exact address then the custom domain's
   catch-all sentinel, read live. 200 is 250, 404 is `550 5.1.1`, anything
   else 451.
2. It checks SPF and DKIM, evaluates DMARC and writes `Authentication-Results`
   in Cloudflare's form (`spf=` for MAIL FROM, `dkim=`, `dmarc=`, each
   present); incoming ones become `Original-Authentication-Results`.
   Nothing is rejected on those results: the spam scorer weighs them.
3. It puts the message in the mail bucket (`inbound/<date>/<uuid>.eml`) and
   publishes its key with the envelope on `mail.inbound` (`Nats-Msg-Id` =
   the key), and answers 250 only after both; else 451, so the sender retries.
4. `consume`'s `mail-inbound` subscriber (`crates/mail-inbound`) runs the
   worker's pipeline: parse (postal-mime's port), recipients, per mailbox
   the store (`resolveInbound`, spam and promotions, attachments, the
   Postgres store's ingest, the raw MIME to `mail/<ws>/<mailbox>/<msg>/raw.eml`),
   rules, contacts, `email:created`, each member's realtime `mail:new`,
   bell and Expo push; it removes the spooled object, then runs the WeldDesk
   inbox fan-out (and WeldBooks', once books is in `RUST_PORTED_MODULES`;
   until then that one is a no-op). A storage failure is retried with
   backoff, then dead-lettered; a redelivery after success finds no spooled
   object and does nothing, and every mailbox ignores a Message-ID it holds.

Differences from Global, on purpose: one delivery per message with every
accepted recipient as the envelope (Cloudflare calls the worker once per
recipient, so its helpdesk and accounting fan-out ran once per recipient);
no consumer WeldMail (MAIL-008), no mailbox Durable Object (MAIL-010), no
Jev auto-labels (Workers AI; mail AI is an unavailable feature). Parity:
`crates/mail-inbound/tests/parity.rs` against fixtures the worker's own code
wrote (`pnpm rust:mail-inbound-fixtures`, checked in CI).

Probes: `/livez` (the process answers), `/readyz` (the master database answers
and the pod is not draining). `/health` keeps the workers' JSON.

Not there yet in the realtime gateway: the whiteboard and document rooms
(Flow's REST routes are ported, its collaborative rooms are not), and the
support side of support rooms
(WeldSuite staff on the admin console stay on Global; `crates/realtime`'s
docs have the design).

Not there yet: group-claim workspaces for a
customer's own provider (P7), the Neon API fallback for a workspace without a stored `database_url` (the
Kubernetes editions always store it), Clerk member linking on
`/api/me/permissions`, and an admin screen for `feature_flag_overrides` (the table
that `FEATURE_FLAGS=master-db` reads; set rows with SQL for now).

## Rules

- **Lints are workspace-wide** (`[workspace.lints]` in `Cargo.toml`): `unsafe`
  is forbidden and clippy's pedantic group is on. Every crate opts in with
  `[lints] workspace = true`.
- **Dependency versions live in `[workspace.dependencies]`**; crates use
  `dep = { workspace = true }`.
- **A new licence in `deny.toml` is a licensing decision.** The backend ships
  under AGPL-3.0-only (OPS-002); say why in the PR.
- **Module crates never depend on each other**, only on shared crates. This is
  how the module boundaries of API-004 are enforced in Rust.
- **A ported route answers exactly like its TypeScript route**: paths, bodies,
  status codes, messages and side effects. The conformance suite is the judge.
- **Bumping the toolchain** is its own PR: `rust-toolchain.toml` and
  `rust-version` in `Cargo.toml` together.
