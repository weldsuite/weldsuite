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
scheduled jobs. `RUST_PORTED_MODULES` (`@weldsuite/api-modules`) has twenty-four
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
  `crates/desk-domain/src/workflow`; the SLA engine, `crates/desk-domain/src/sla.rs`,
  re-derives a conversation's clocks on every write and `weldsuite cron
  desk-sla-sweep` announces warnings and breaches) and **stash** (the WMS, with the
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
  WooCommerce, Shopify and Picqer, categories, orders with WeldBooks' sales
  tax engines (manual, Stripe Tax and Avalara, `crates/books-domain`),
  parcels, shipments, pickups, returns, shipping rules and prices, carriers,
  parcel analytics, rates, settings, wallet and notifications, Sendcloud and
  PrintNode, and the B2B order portal: its staff routes and the public portal
  at `/public/commerce-portal` (its invoice document is WeldBooks' invoice
  layout), with the sign-in limits on the cache's atomic counters and the
  sign-in mail as system mail; `crates/commerce-domain` holds the portal's
  tokens, slugs and limits; the sales channels' store clients and field crypto
  are `crates/connect-domain`'s. Not yet: WooCommerce's app-auth callback, which
  completes a WeldConnect authorisation)
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
  Stripe. An inbound call marks the desk SLA due, as the worker does)
- **host** (WeldHost: domains, their dashboard, search and availability
  through Realtime Register's ADAC checker (its REST check on OTE), priced
  from the master `domain_pricing`, the registrar toggles, sync, auth codes,
  registration polling and incoming transfers on Realtime Register (and the
  legacy Cloudflare Registrar for its rows), external domains and their
  ownership check over DNS over HTTPS, DNS zones and records on Cloudflare's
  API (behind the `DnsHost` port, so another DNS host can be plugged in),
  email forwards and Realtime Register's process webhook at
  `/public/webhooks/realtime-register`; the WeldReach guards read the tenant's
  `reach_domains`. Buying and renewing a domain is a Stripe charge, so the
  checkout and renewal routes answer as the worker does without Stripe, and
  `weldsuite cron domain-auto-renew` does nothing yet. Not ported: the test
  environment's DNS sandbox (a D1 emulator of Cloudflare's API))
- **meet** (WeldMeet: meetings, invitations with their calendar file,
  instant meetings, live sessions with join, leave, end and the waiting
  room, host controls, the in-meeting chat, CRM transcripts, the wallet gate
  for meeting AI, and the video provider behind `crates/video-rooms`:
  RealtimeKit, which conformance compares, or LiveKit, which
  `VIDEO_PROVIDER`/`LIVEKIT_URL` select. RealtimeKit's signed webhooks are
  served as on Global; LiveKit's (`/api/webhooks/livekit`, Rust only) track
  presence and the end of a room, with no recorder or AI events. Not served:
  WeldChat calls in "one live call at a time" (no chat calls on Kubernetes),
  the transcript, summary, recording-copy and backfill Workflows (the routes
  answer as the worker without the binding does), and the recordings bucket;
  see `meet-transcription` and `meet-recordings` below)
- **reach** (WeldReach, cold-email outreach: access, settings, domains
  connected to Mailpool through its Cloudflare integration with the DNS
  guards over DNS-over-HTTPS, mailboxes provisioned at Mailpool and entered
  in the warmup pool, prospects and their imports, lists, campaigns,
  suppressions, the overview, the reply inbox with answers sent from the
  customer's own mailbox over SMTP (lettre), the CRM hand-off, and
  Mailpool's webhook at `/public/reach/webhooks/mailpool`, all behind the
  `weldreach` app-access gate; the shared logic is `crates/reach-domain`.
  The inbox subscription is Global's billing-worker (Stripe); here billing
  is off, as for bank connections: mailboxes are provisioned unbilled,
  `GET /billing` is `null` and `POST /billing/setup` answers 409
  `BILLING_OFF` (the platform leaves out the payment step). The send engine
  runs as `weldsuite cron reach-send-sweep` and the `reach-send`
  subscriber of `weldsuite consume` (NATS stream `REACH_SEND`; without
  NATS the cron sends itself), with the hourly `reach-warmup-sweep` and the
  daily `reach-slot-reconciliation`. Replies, auto-replies and bounces
  (reach-api's `email()` handler, Cloudflare Email Routing on Global) come
  in through Haraka: see "Inbound mail" below. The AI label of a reply is
  not available (no AI port, as for mail AI): a reply that answers a
  campaign is labelled `unclassified`, as reach-api does without a model,
  and a person labels it. The warmup network (`reach-warmup-worker`,
  `modules/reach/src/warmup_network`): the pool's mailboxes write to each
  other over their own SMTP logins (lettre) and the recipient engages each
  mail over IMAP (`async-imap` over rustls, the `ImapConnector` port:
  found, rescued from Junk, opened, flagged, sometimes answered), as
  `weldsuite cron reach-warmup-dispatch` (every minute),
  `reach-warmup-plan` (every 30 minutes, with the login recheck) and
  `reach-warmup-daily` (02:30 UTC: ramp, stats, auto-pause and resume,
  cleanup of old warmup mail), and the `reach-warmup-send` and
  `reach-warmup-engage` subscribers of `weldsuite consume` (NATS stream
  `REACH_WARMUP`; without NATS the dispatch sends and engages itself); kill
  switch `weldreach-warmup`. The corpus is the built-in one: Global
  refreshes it monthly with AI, which these editions do not have. Parity:
  `tests/warmup_parity.rs` and `tests/warmup_planner_parity.rs` against
  fixtures the worker wrote (`pnpm rust:reach-warmup-fixtures`))
- **books** (WeldBooks, one crate per area on `crates/books-domain`, plan
  and status in `modules/books/PORTING.md`: the ledger (entities, settings,
  GL accounts, journal entries, fiscal periods, tax rates, FX rates on the
  ECB feed, dimensions); sales (invoices with their designed templates and
  the printed invoice, Brazil's Pix BR Code included, payments, recurring
  invoices); purchases (bills, accounting contacts, documents, W-9 requests
  and `/public/w9`, payment runs with NACHA, checks and Positive Pay);
  banking (accounts, transactions, deposits, reconciliation and its rules,
  bank feeds on Plaid, Stripe Financial Connections, Ponto over mTLS and
  Enable Banking); US sales tax (settings, agencies, jurisdictions, rules,
  zones, exemption certificates, reports, nexus, returns and the tax
  calendar, on the manual engine, Stripe Tax and Avalara); reports and US
  compliance (financial reports, dashboard, XAF export, payroll imports and
  Gusto, fixed assets and depreciation, Form 1099 and its filings); VAT, GST
  and Brazil (VAT returns, ICP declarations, the GST worksheet, br-tax, NF-e
  and NFS-e on Focus NFe, received fiscal documents and the Focus webhook at
  `/public/fiscal-webhooks`). Every third-party API goes through the
  outbound HTTP port. `weldsuite cron books-sweep` runs the daily sweep:
  overdue invoices, due recurring invoices, the ECB rates, the US tax
  reminders (in-app notifications to owners and admins, sent once: the
  markers live in the cache with their TTL) and the depreciation due. hr's
  pay run journal posts in process (`books_domain::payroll`); the
  integration workers' bank feed endpoints are `books_domain::bank_feeds`,
  for when those workers are ported. Not ported: document OCR (Workers AI)
  and filing through Digipoort, both in `unavailableFeatures`)
- **docs** (WeldDocs: documents as WeldDrive files, room sessions, the live
  snapshot, version history with restore). Live editing runs in the
  collab-rooms service, the workers' own `DocRoom` on Node beside this
  server (`rust/docs/collab-rooms.md`, the chart's `collabRooms`): the
  server calls each room over HTTP on the pod that holds it and proxies the
  room sockets (`/api/docs/connect`); the engine stays TypeScript
- **sheets** (WeldSheets: spreadsheets as WeldDrive files and WeldFlow
  project sheets, room sessions, .xlsx/.csv/.tsv imports and exports, the
  in-place conversion of old project sheets, version history with restore,
  connected tables). Its rooms are the workers' own `SheetRoom` in the same
  collab-rooms service, and the work its routes do without a room (a new
  workbook, reading an import, a version's .xlsx, a connected table's
  listing with the workspace's database) is the sheets engine there
  (`SHEET_ENGINE`, `apps/workers/sheets-api/src/engine-ops.ts`); scheduled
  refreshes run on the rooms' alarms. Not ported: `/internal/agent/*` (the
  `SheetsInternal` entrypoint the WeldAgent tools call from agent-api,
  chat-api and app-api), which waits for those workers' ports
- **panel** (WeldPanel, product analytics, phase 1: projects with their
  token, settings, pausing, rotation and the install check at
  `/api/panel/projects`, kept in step with the master
  `panel_project_registry` row and the cache record the collector reads;
  and the public collector panel-ingest is on Global, served at
  `/public/panel` and, so a snippet's script origin is a collector, at
  `/s.js`, `/c/{token}` and `/e` on every host. What Cloudflare gives the
  collector is, here: the events stream (Pipelines into the Basin table
  `panel.events_v1`) is a NATS JetStream stream, one message per row on
  `panel.events.v1.<workspace>`, deduplicated on the event id; the daily
  salt of the cookieless visitor hash (the `PanelSalt` Durable Object) and
  the per-workspace daily counts (`PanelUsage`) live in Valkey, the salt
  claimed by the first pod and expiring as the object's alarm deletes it;
  the client address is the ingress's `X-Forwarded-For` entry, and there is
  no geo (Cloudflare's `request.cf`), so `country`, `region` and `city` stay
  null. A project record missing from the cache is read from the master
  registry. Nothing reads the events yet: reports, recordings and people
  are later WeldPanel phases, and their store (a consumer of the stream
  into Postgres or a columnar store) comes with them)

The integration workers (`integration-webhook-worker`, `integration-sync-worker`)
have no module id; `modules/integrations` serves their parts that are ported at the
workers' own paths beside `/api` (point a provider, or an `integration-webhooks.<domain>`
ingress host, at the server), with conformance suites named `integrations: …`:

- **bank feeds**: `POST /webhooks/bank-feeds/:provider` (Stripe Financial Connections'
  HMAC with `STRIPE_FC_WEBHOOK_SECRET`, Plaid's ES256 token with its key fetched from
  Plaid and cached; Ponto and Enable Banking are polled, so refused), forwarding to
  WeldBooks' internal bank-connection routes in process (`books.rs`, once books is in
  `RUST_PORTED_MODULES`; until then the forward fails as without `BOOKS_INTERNAL` and
  the delivery is still acknowledged), and `weldsuite cron bank-feed-due` (the master
  `bank_feed_connection_index`)
- **GitHub**: the App's `POST /webhooks/github` (installation status, one inbound sync
  per link per minute) and the Workflows as jobs, `integrations.github-project-sync`
  (`GITHUB_PROJECT_SYNC`, which WeldConnect's "Sync now" now starts on Kubernetes) and
  `integrations.github-project-outbound` (`GITHUB_PROJECT_OUTBOUND`; registered, but
  WeldFlow's Rust task routes do not dispatch it yet)
- the entity-webhooks queue consumer and the outgoing-webhook retry sweep are the hub's
  `webhooks` subscriber (`crates/subscribers`), already

Not yet: the CRM sync (`CRM_SYNC`: Attio, HubSpot, Google Calendar; WeldConnect's
CRM routes answer as without the binding), its webhooks (`/webhook/:connectionId`,
`/webhook/hubspot`, `/webhook/gcal/:connectionId`) and due sweep, the connector
receivers and catch-up (`/webhooks/connectors/:connectionId`, Stripe Connect, the
Moneybird push sweep), the workflow trigger receivers (`/integration-webhook/slack`,
`/twilio/:id`, `/github/:id`) and the Google and Airtable polls, Meta's ad webhook and
the ad metrics sweep, and the WooCommerce app-auth forward.

personal-api (consumer WeldMail and WeldCalendar on a person's own account,
outside any workspace: ADR MAIL-008, DATA-011) has no module id either:
`modules/personal` serves it at `/personal-api` on this host, the worker's
own paths below it (`/personal-api/api/me`, …), because they collide with
app-api's and calendar-api's (`/api/me`, `/api/calendars`) on the one host
(OPS-013). A consumer app's personal-api base URL is `https://<host>/personal-api`
there (`VITE_PERSONAL_API_URL`, `EXPO_PUBLIC_PERSONAL_API_URL`), as it is
`https://personal-api.weldsuite.org` on Global. It is served when
`DATABASE_URL_PERSONAL` names the shared personal database (a database of its
own, `packages/core/db/drizzle/personal-migrations`, migrated by `weldsuite
migrate`); without it `/personal-api` is the server's 404. Everything is
ported: the session (the deployment's verifier, with Clerk's authorized
parties being the consumer apps' and the Clerk Billing plan claims read for
the entitlements; an OIDC token has neither, so the free plan), the personal
account lookup, onboarding, the profile, push tokens, calendars, events,
booking pages and their slots, bookings, the mailboxes, labels, drafts,
messages with the "email read" Expo push, compose, reply and forward through
WeldMail's transport and outbound ledgers (`MAIL_SMTP_URL`, ledger key
`personal:<accountId>`, the plan's daily limit), and subscriptions (the scan
reads the stored raw headers, one-click, the unsubscribe mail, the link).
Not served: the free `@weldmail.com` addresses (`/api/mail/weldmail`,
`mail-free-addresses` below), whose domain belongs to Global (MAIL-010), so
on Kubernetes no personal mailbox gets created and the inbound path
(`crates/mail-inbound`) still skips personal addresses. Suites
`personal: account`, `personal: calendar`, `personal: booking` and
`personal: mail`.

The public API (external-api, `api.weldsuite.org` on Global) is served at
`/v1` on the same host as `/api` (`modules/external-api`, in progress): its own
authentication instead of the session pipeline (`wsk_` keys through the master
`api_key_registry` and the live key row, `wsat_` app tokens, both cached on
the cache port), the licence and read-only gate, the per-workspace rate limit
on the cache's counters (Valkey, exact across pods), `GET /v1`,
`/v1/health/db`, `/v1/settings`, and WeldApps' surface: `POST /v1/oauth/token`,
`/v1/app-storage` and `/v1/user-apps` (the `weld` CLI). It is not an
`api-modules` module, so it is not in `RUST_PORTED_MODULES`: each `/v1`
object group is mounted where its module is. The WeldApps gateway reaches it
over HTTP through the release's own Service (the chart sets `EXTERNAL_API_URL`).
The `/v1/<object>` groups served so far: CRM (people, companies, leads,
opportunities, pipelines, pipeline-stages, activities, quotes), Flow
(projects, tasks, time-entries, milestones, goals, sprints, task-comments,
task-tags, project-documents/files/labels/members/messages, whiteboards),
desk's articles, tickets and conversations (on `desk-domain`'s inbox),
commerce (categories, products, orders), chat (channels, channel-members,
chat-messages/bookmarks/drafts/sections), calendar (calendars,
calendar-events), social (accounts, campaigns, analytics, media, and posts
with publishing through `social-domain`), WeldBooks
(the read-only ledger, accounting-settings, accounting-contacts), WeldHost
(domains with their DNS zones and records, kept local as on Global), WeldKnow
(knowledge-spaces and -pages, on `know-domain`'s access rules), the
drive (files with their content, folders, drive aggregates) and WeldConnect
(webhooks with the event catalog in its declared order, workflows with
schedules and executions; served once `connect` is in `RUST_PORTED_MODULES`).
Their bodies are validated with the client packages'
Zod schemas, which `modules/external-api/tools/generate.mts` writes out as
data (`schemas_gen.rs`, read by `zod.rs`), with the tables' insert and patch
statements (`tables_gen.rs`); rerun it when a schema or a table changes. Not
yet: mail (8 groups), custom-objects and reach. Flow's sheets are not
served on Kubernetes yet.

The MCP server (`mcp-server`, `modules/mcp`, design in `docs/mcp-server.md`)
is served at `/mcp` on the same host, with its OAuth discovery documents at
`/.well-known/oauth-protected-resource` and
`/.well-known/oauth-authorization-server` (the issuer's metadata passed
through). The bearer token is an access token the server's own session
verifier accepts (`AUTH_PROVIDER=oidc`: the issuer's, the organization from
`OIDC_ORG_CLAIM`); the member's effective permissions in that workspace are
the authority, and each workspace has a per-minute limit by plan on the
cache's counters. Its tools are the TypeScript server's catalog, generated
from the worker itself (`modules/mcp/tools/generate.mts`: `tools/list`'s
definitions, each tool's route into `/v1`, its Zod shape as data); a call
runs the public API's `/v1` router in process with the member as the caller
(method-aware permissions in place of key scopes), so a tool is offered once
its `/v1` group is served. Not yet offered: the tools of the `/v1` groups
above that are not ported yet, the routes whose MCP copy differs from
external-api's (creating a project or a product, tickets and conversations,
social media) and the MCP-only social approvals and media upload, the
WeldObjects tools (`/v1/custom-objects`), and Clerk's `submit_feedback`
(needs Clerk's secret key). The `mcp-server` conformance suite runs the
worker's endpoint tests against both.

Features this backend lacks inside the modules it serves are listed in
`/config.json` as `unavailableFeatures` (`bins/weldsuite/src/edition.rs`), so
the platform hides them: SSO connections, billing, credit top-up, paid apps,
desktop sign-in, analytics, search reindex, company logos, mail domains, free
`weldmail.com` addresses, mail AI, chat calls, help center custom domains,
sending the loonaangifte over Digipoort, WeldBooks document OCR, filing VAT
returns through Digipoort, buying or porting phone numbers, buying or
renewing domains, WeldMeet transcripts and summaries and recordings,
WeldConnect's AI (`weldconnect-ai`: the editor's Generate with AI, AI steps), and
WeldAgent's AI (`agent-ai`: the assistant chat, agent runs, routine tests
and teach mode, on Claude Managed Agents and `@weldsuite/ai` on Global).
One follows the deployment rather than the code: `collab-rooms` (WeldDocs and
WeldSheets, hidden altogether) when no collab-rooms service is configured
(`COLLAB_ROOMS_URLS`, the chart's `collabRooms.enabled: false`).
Routes left out on purpose are in their suite's `excludedRoutes`, with the
reason. Not ported yet (P8):
connect and agent, and the edge workers (the rest of `external-api`
and of `mcp-server`'s tools, the rest of the integration workers, above;
personal-api is ported). WeldAgent stays
off on Kubernetes while there is no AI provider: an agent that cannot chat
or run does nothing for a user, so its data routes are not ported either
and wait for an EU AI provider. Its event subscriber (`weldagent`) and the
hourly routine sweep run agents and stay off with it.

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
  crates/ports/         ports (cache, event bus, realtime, flags, files, jobs, system mail, identity, database provisioning, IMAP),
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
                        files over the S3 API, system mail over SMTP, IMAP (async-imap), identity on Zitadel, workspace databases on
                        CloudNativePG shards; `realtime.rs` is the realtime backplane's wire format on Valkey (stamped
                        events, replay log, presence)
  crates/realtime/      the realtime WebSocket gateway in `serve` (the realtime-worker's hubs and rooms, every pod,
                        Valkey between them); mounted by bins/weldsuite/src/realtime.rs
  crates/emails/        @weldsuite/emails: the exported templates rendered with minijinja, sendSystemEmail
  crates/desk-domain/   WeldDesk rules the desk modules share: webchat, assignment and the AssignmentRouter,
                        the inbox for writers outside it (inbox.rs, attributes.rs: WeldConnect's helpdesk steps
                        and the public API; list.rs: the inbox list and timeline pages),
                        the SLA engine (sla.rs, sla_calendar.rs), the helpdesk workflow engine (`workflow/`:
                        handlers, the desk.conversation-workflow job); tests/fixtures from
                        `pnpm rust:desk-workflow-fixtures` (helpdesk-workflow-worker on pglite) and
                        `pnpm rust:desk-sla-fixtures` (the TypeScript SLA engine)
  crates/know-domain/   WeldKnow's teamspace access rules (@weldsuite/know-domain/access) know and external-api
                        share; a workspace API key (no user) reaches open teamspaces only
  crates/apps-domain/   WeldApps rules core-apps and external-api share: the user-apps request schemas and manifest,
                        scopes, reserved codes, and adopting first-party installs onto an official hosted app
  modules/external-api/ the public API at /v1 (external-api): key and app-token auth, licence gate, rate limit,
                        WeldApps' token grant, app storage and the CLI's developer API, and the object groups;
                        tools/generate.mts writes their Zod schemas and tables as data
  modules/mcp/          the MCP server at /mcp (mcp-server): the transport, JSON-RPC, OAuth bearer auth and rate
                        limit, the tool catalog generated from the worker (tools/generate.mts, catalog/), tool calls
                        into /v1 in process, present.rs (the worker's text answers), WeldApps' agent tools
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
                        modules/reach (WeldReach, with crates/reach-domain: campaigns, prospects,
                        the inbox, the send window, the warmup pool and network, MIME),
                        modules/hr (WeldHR and payroll, with crates/payroll-domain: the
                        Dutch and US engines, SEPA, NACHA, the loonaangifte, US forms, PDFs),
                        modules/call (WeldCall: Telnyx, the webhook),
                        modules/personal (personal-api at /personal-api: consumer WeldMail
                        and WeldCalendar on the shared personal database),
                        modules/integrations (the integration workers: the bank feed and
                        GitHub App receivers, the GitHub jobs, the bank feed due sweep;
                        tests/fixtures from `pnpm rust:integration-fixtures`),
                        modules/host (WeldHost: Realtime Register, Cloudflare's zones and
                        registrar, DNS over HTTPS, the Realtime Register webhook),
                        modules/meet (WeldMeet, with crates/video-rooms: RealtimeKit and LiveKit
                        rooms, and LiveKit's webhook verification),
                        modules/panel (WeldPanel: projects, the registry sync, and the public
                        collector in `collector/`: the wire format, rows, URLs, user agents,
                        IP filters, the cookieless visitor id),
                        modules/books (the WeldBooks ledger) and one crate per books area,
                        modules/books-sales, -purchases, -banking, -sales-tax, -reports and
                        -tax, with crates/books-domain (everything two areas or another module
                        share: tables, the posting engine, currency and FX, jurisdictions, the
                        sales tax engines, the invoice layouts, bank feeds, payroll posting;
                        commerce and hr use it; plan in modules/books/PORTING.md),
                        modules/docs (WeldDocs; its rooms through the CollabRooms port and
                        the collab-rooms service, apps/tools/collab-rooms);
                        modules/sheets (WeldSheets; its rooms and the sheets engine the same way,
                        connected tables' definitions checked against catalogs/sheet-data.json);

                        core is split over
                        modules/core-files (app-api files, folders, drive, search, storage),
                        modules/core-objects (WeldObjects, custom fields, object templates, grid views),
                        modules/core-team (team, roles, settings, preferences, app catalog),
                        modules/core-platform (notifications, audit logs, appstore, API keys, credits,
                        dashboard, support, SSO, auth sessions), modules/core-apps (WeldApps and its
                        gateway, the CLI and desktop sign-in routes), modules/core-onboarding (signup:
                        /api/onboarding, the workspace.provision job, the identity sync, the deletion sweeps)
  deploy/helm/weldsuite the Helm chart (collabRooms: WeldDocs' and WeldSheets' rooms, apps/tools/collab-rooms)
  docs/collab-rooms.md  how the collaborative rooms run on Kubernetes
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
pnpm rust:desk-sla-fixtures     # re-export what the TypeScript SLA engine answers, for crates/desk-domain/tests/sla_parity.rs
pnpm rust:mail-inbound-fixtures # re-export what mail-inbound-worker does, for crates/mail-inbound/tests/parity.rs
pnpm rust:integration-fixtures  # re-export what the integration workers' sweeps and GitHub Workflows do, for modules/integrations/tests
pnpm rust:reach-inbound-fixtures # re-export what reach-api's email() handler does, for modules/reach/tests/inbound_parity.rs
pnpm rust:reach-warmup-fixtures # re-export reach-warmup-worker's rules, corpus and a planner run, for modules/reach/tests/warmup_*parity.rs
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
| `WELDSUITE_TEST_IMAPS`, `WELDSUITE_TEST_IMAP_PLAIN` | an IMAP server on implicit TLS and plain (`host:port`), e.g. `docker run -p 3993:3993 -p 3143:3143 -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=warm1:secret1@alpha.test -Dgreenmail.users.login=local_part" greenmail/standalone:2.1.3` | IMAP adapter (`crates/adapters-oss/tests/imap_server.rs`) |

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
(`packages/core/db/drizzle/{master,tenant,personal}-migrations`) to the master database,
to every active workspace's tenant database, and to personal-api's shared
personal database when `DATABASE_URL_PERSONAL` is set (`--personal`;
`pnpm db:migrate:personal`'s twin, `drizzle.__drizzle_migrations`; skipped
without the URL). `crates/migrations/build.rs`
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
DATABASE_URL_PERSONAL=postgres://… weldsuite migrate --personal
weldsuite migrate --tenants --only ws_123 --check-journal
```

## Running it

```bash
docker build -f rust/Dockerfile -t weldsuite:dev .                                       # from the repo root: the server and the platform SPA
docker build -f rust/Dockerfile --target sign-portal -t weldsuite-sign-portal:dev .     # the WeldSign signer portal (Node, ADR FE-017)
docker build -f rust/Dockerfile --target collab-rooms -t weldsuite-collab-rooms:dev .   # WeldDocs' and WeldSheets' rooms (Node, docs/collab-rooms.md)
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
every 15 minutes, `desk-sla-sweep` every minute (WeldDesk's SLA warnings
and breaches), `reach-send-sweep` every minute (WeldReach's sends: queued
on NATS for `weldsuite consume`'s `reach-send` with `REACH_SEND_QUEUE=nats`,
which the chart sets with `consume.enabled`, else sent by the job itself),
`reach-warmup-sweep` hourly and `reach-slot-reconciliation` daily (WeldReach's
warmup progress and Mailpool slots), `reach-warmup-dispatch` every minute,
`reach-warmup-plan` every 30 minutes and `reach-warmup-daily` at 02:30 UTC
(WeldReach's warmup network; the dispatch queues on NATS for
`weldsuite consume`'s `reach-warmup-send` and `reach-warmup-engage` with
`REACH_WARMUP_QUEUE=nats`, which the chart sets with `consume.enabled`, else
sends and engages itself), `identity-sync` every minute (the identity provider's
changes into the databases, what Clerk's webhooks do on Global),
`workspace-deletion` daily, `workspace-teardown` hourly,
`domain-auto-renew` daily (off: WeldHost's renewals charge through Stripe,
which stays with Global), `workflow-schedules` every minute (WeldConnect's
scheduled runs, started on Restate; skipped without `RESTATE_INGRESS_URL`) and
`bank-feed-due` every 15 minutes (WeldBooks' bank feeds due a sync; nothing while
books is not served). The server reads environment variables only (`bins/weldsuite/src/config.rs`):

| Variable | |
|---|---|
| `DATABASE_URL_MASTER` | master database (required) |
| `DATABASE_URL_PERSONAL`, `PERSONAL_DB_MAX_CONNECTIONS` | personal-api's shared personal database (optional; set, `/personal-api` is served) and its pool size (default 5) |
| `AUTH_PROVIDER` | `clerk` (default) or `oidc` (ADR SEC-012) |
| `CLERK_JWT_KEY`, `CLERK_JWKS_FILE`, `CLERK_JWKS_URL` or `CLERK_SECRET_KEY` | with `clerk`: session token keys: a PEM, a JWKS file, a JWKS URL, or Clerk's Backend API (one is required) |
| `OIDC_ISSUER`, `OIDC_AUDIENCE` | with `oidc` (both required): the issuer (`iss`, and where discovery reads `/.well-known/openid-configuration`) and the accepted audiences, comma separated (Zitadel: the project id) |
| `OIDC_ORG_CLAIM` | the claim naming the session's organization (default `urn:zitadel:iam:org:id`; Zitadel's project-roles claim works too). Its value is matched against `workspaces.clerk_org_id`, which holds the provider's organization id on Kubernetes, or `workspaces.id` |
| `OIDC_JWKS_URL`, `OIDC_WEB_CLIENT_ID` | fetch the keys here instead of through discovery; the platform's PKCE client id for `/config.json` (both optional) |
| `DATABASE_ENCRYPTION_KEY`, `DATABASE_ENCRYPTION_KEY_V2` | open encrypted `workspaces.database_url`; open the Sendcloud secret a workspace stored for WeldStash's ship action; seal and open WeldAds' Meta tokens (`encryptField`); open WeldCommerce's store connection, Sendcloud and sales tax engine credentials; seal and open WeldBooks' stored credentials, tax ids and bank account numbers |
| `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_SIP_CONNECTION_ID`, `TELNYX_PUBLIC_KEY` | WeldCall: Telnyx's API key (unset: the phone service is not activated), the Call Control connection numbers are synced from and the WebRTC credential connection, and the account's Ed25519 public key `/public/webhooks/telnyx` checks every webhook with (unset: every webhook is refused, 401). The voice agent's tool tokens are signed with the API key |
| `APP_API_PUBLIC_URL` | WeldDesk and WeldCall: this server's public base URL, for the URLs a third party calls back on (OAuth redirects, the voice agent's `lookup_crm` tool); by `ENVIRONMENT` otherwise |
| `COMMERCE_PORTAL_URL` | WeldCommerce: the B2B order portal's origin, for the links in its sign-in mail and the portal URL its settings show (default by `ENVIRONMENT`: `https://orders.weldsuite.org` in production, `https://orders-test.weldsuite.org` in test, else `http://localhost:3021`) |
| `PLATFORM_URL`, `BOOKS_API_URL`, `DIGIPOORT_MODE`, `BANK_FEED_PROVIDERS`, `BANK_FEED_WEBHOOK_URL`, `PLAID_CLIENT_ID`/`_SECRET`/`_ENV`/`_COUNTRY_CODES`/`_REDIRECT_URI`, `STRIPE_FC_SECRET_KEY`/`_API_VERSION`, `PONTO_CLIENT_ID`/`_CLIENT_SECRET`, `PONTO_MTLS_CERT`/`_KEY`, `ENABLE_BANKING_APP_ID`/`_PRIVATE_KEY`, `FIELD_ENCRYPTION_AAD_WRITES` | WeldBooks: the platform origin for W-9 links, this API's public URL for Focus NFe's webhook, Digipoort's mode (`simulated`, the only one without PKIoverheid certificates), the bank feed providers on offer and their webhook URL, each provider's credentials (Ponto's mTLS client certificate and key as PEM), and the field-encryption AAD switch the workers share. Stripe Tax, Avalara, Gusto and Focus NFe use the credentials a workspace stores (sealed with `DATABASE_ENCRYPTION_KEY`). The daily `books-sweep` keeps the tax reminders' markers in Valkey: without `VALKEY_URL` it sends none |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | WeldAds: the Meta app ad connections authorize (unset: connecting answers 500 `Facebook OAuth is not configured`); the OAuth callback page is on `PUBLIC_APP_URL` (default `https://app.weldsuite.org`). The OAuth state lives in Valkey, or in this process without it |
| `POSTPEER_API_KEY`, `POSTPEER_BASE_URL`, `POSTPEER_APP_IDS`, `POSTPEER_WEBHOOK_SECRET` | WeldSocial: PostPeer's API key (unset: connecting and publishing answer 400 `Social publishing is not configured`), its base URL (default `https://api.postpeer.dev/v1`), the BYOK OAuth apps as a JSON object of platform → app id, and the secret PostPeer signs its delivery webhooks with (unset: every delivery is refused). Publishing charges the workspace's prepaid credits (2 per platform) |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `CONNECT_API_URL` | WeldConnect: the GitHub App (WeldFlow's repositories and Projects, the workflow GitHub integration; unset: those routes answer 500 `GitHub App is not configured`) and the public origin of the workflow webhook URLs (default by `ENVIRONMENT`). The install state is signed with `CLERK_SECRET_KEY`, else `INTERNAL_API_SECRET`; the install callback lands on `PUBLIC_APP_URL`. `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET` and `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`: the workflow integrations' OAuth apps |
| `TELNYX_API_KEY` | WeldConnect: the `send_sms` step's Telnyx key (unset: the step fails `TELNYX_API_KEY not configured`). `send_email` steps go out through the customer-mail relay (`MAIL_SMTP_URL`) and the outbound guard, from one of the workspace's mailboxes; `INTERNAL_API_SECRET` is the bearer of `/api/internal/workflow-actions/*` (the engine runs those actions in the process) |
| `LEMLIST_API_KEY` | WeldData: the shared Lemlist key for the lead database (unset: searches and the filter catalog answer 500 `Lead database is not configured`). Search pages and the catalog are cached in Valkey when it is set |
| `MAILPOOL_API_KEY`, `MAILPOOL_API_URL`, `MAILPOOL_WEBHOOK_SECRET`, `WELDREACH_WARMUP_KEY`, `REACH_INBOUND_DOMAIN` | WeldReach: the Mailpool account mailboxes and domains are provisioned on (unset: those routes answer 503 `SERVICE_UNAVAILABLE`), its API base (default `https://app.mailpool.io/v1/api`), the secret its webhooks are signed with (unset: 503), the key the warmup pool seals mailbox logins with (the workers' value; unset: a mailbox create answers 503 `WARMUP_NOT_CONFIGURED`, and the warmup jobs cannot open any login, so they park the mailboxes they touch with `credentials_unavailable`), and the domain Mailpool forwards replies to (`reply+<token>@…`; unset: 503 `INBOUND_NOT_CONFIGURED`, and no replies are taken in: `serve`'s RCPT check and `consume` read it too) |
| `REACH_SEND_QUEUE` | `nats`: `weldsuite cron reach-send-sweep` queues each workspace with outreach due on NATS for the `reach-send` subscriber of `weldsuite consume` (the chart sets it with `consume.enabled`); unset: the job sends itself |
| `REACH_WARMUP_QUEUE` | `nats`: `weldsuite cron reach-warmup-dispatch` queues the warmup mail due to be sent or engaged on NATS (`REACH_WARMUP`) for the `reach-warmup-send` and `reach-warmup-engage` subscribers of `weldsuite consume` (the chart sets it with `consume.enabled`); unset: the job sends and engages itself |
| `FINDYMAIL_API_KEY`, `PROSPEO_API_KEY` | WeldData: the email finder's providers, read by the `data.welddata-enrich` job (unset: the cells of that provider fail with `… is not configured`) |
| `REALTIME_REGISTER_API_KEY`, `REALTIME_REGISTER_CUSTOMER`, `REALTIME_REGISTER_OTE`, `REALTIME_REGISTER_ADAC_API_KEY`, `REALTIME_REGISTER_ADAC_TLD_SET_TOKEN`, `REALTIME_REGISTER_CONTACT_ADMIN`/`_TECH`/`_BILLING`, `REALTIME_REGISTER_WEBHOOK_SECRET` | WeldHost: Realtime Register's API key and customer handle (unset: search, availability, transfers and the registrar toggles answer as the worker does without them), `true` for its OTE, the ADAC key and TLD set for search, the platform contact handles domains are registered on, and the `?token=` of its process webhook (unset: every delivery is refused) |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (or `CF_ACCOUNT_ID`) | WeldHost: Cloudflare's API for DNS zones and records (and the legacy Cloudflare Registrar's rows); unset: the DNS record routes and the ownership check answer 500 `Cloudflare integration is not configured.` |
| `CLERK_AUTHORIZED_PARTIES` | extra origins allowed as `azp` |
| `PERMISSIONS_APP_ENFORCE` | `true` refuses per-app denials instead of logging them |
| `VIDEO_PROVIDER`, `LIVEKIT_URL`, `LIVEKIT_API_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_TOKEN_TTL_SECONDS` | WeldMeet's video provider (`crates/video-rooms`): `livekit` (the default once `LIVEKIT_URL` is set) or `realtimekit` (`CF_ACCOUNT_ID`, `CF_REALTIME_APP_ID`, `CF_REALTIME_APP_SECRET`). `LIVEKIT_URL` is what browsers connect to and what `/config.json` gives the platform (`videoProvider`, `videoUrl`); `LIVEKIT_API_URL` the API when it is reached elsewhere (in the cluster); the key pair signs join tokens and admin calls and verifies `/api/webhooks/livekit`; tokens can be used for `LIVEKIT_TOKEN_TTL_SECONDS` (600). See "WeldMeet on LiveKit" below |
| `VALKEY_URL`, `VALKEY_CACHE_PREFIX`, `VALKEY_REALTIME_PREFIX` | cache, realtime publish and the WebSocket gateway (optional; without it, upload tokens live in the server process, enough for one replica only, and the gateway is off) |
| `REALTIME_PUBLIC_URL` | the gateway URL `/config.json` gives the frontends (default: the request's own origin with `/ws`) |
| `REALTIME_MAX_CONNECTIONS`, `REALTIME_MAX_CONNECTIONS_PER_USER`, `REALTIME_MAX_SUBSCRIPTIONS`, `REALTIME_MAX_MESSAGE_BYTES`, `REALTIME_SEND_QUEUE` | gateway limits per pod (20,000 sockets, 100 per person, 2,000 topics per socket, 1 MiB messages, 1,024 queued messages before a slow client is dropped) |
| `REALTIME_INTERNAL_SECRET` | `x-internal-secret` of `/publish/*` and `/internal/presence` (optional; unset refuses them) |
| `VALKEY_DESK_ASSIGNMENT_PREFIX` | WeldDesk: where the `AssignmentRouter` keeps each workspace's rotation and recent picks on Valkey (default `weldsuite:desk-assignment:`), so auto-assignment's round robin holds across pods. Without `VALKEY_URL` they live in the server process (one replica's worth) |
| `STRIPE_FC_WEBHOOK_SECRET` | The bank feed receiver: the signing secret of Stripe Financial Connections' webhook endpoint (unset: every Stripe FC delivery is refused, 401). Plaid's deliveries are checked with `PLAID_CLIENT_ID`/`PLAID_SECRET`/`PLAID_ENV` (unset: 404) |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | The GitHub App: its id and private key (PKCS#1 or PKCS#8 PEM) for installation tokens (unset: the GitHub jobs fail at `acquire-token`, as on Global), and the App-level secret `POST /webhooks/github` checks each delivery with (else the connection's own; neither: 401) |
| `DISCORD_BOT_TOKEN` | WeldDesk: the bot a helpdesk workflow posts its messages to a Discord conversation with (optional; unset: nothing is posted, as on Global without it). Slack conversations use the bot token of the workspace's Slack integration |
| `WIDGET_TOKEN_SECRET` | WeldDesk: the helpdesk widget API (`/public/helpdesk-widget`) signs its visitors' conversation-room tokens with it and the gateway verifies them, the workers' value (optional; unset: `POST /api/realtime/token` answers 500 and visitors get no live updates) |
| `NATS_URL`, `NATS_USER`/`NATS_PASSWORD` or `NATS_TOKEN`, `NATS_ENTITY_EVENTS_STREAM`, `NATS_ENTITY_EVENTS_SUBJECT`, `NATS_ENSURE_STREAMS` | entity events (optional) |
| `NATS_PANEL_EVENTS_STREAM`, `NATS_PANEL_EVENTS_SUBJECT`, `NATS_PANEL_EVENTS_MAX_AGE_DAYS` | WeldPanel: the events stream the collector writes `events_v1` rows to (default `PANEL_EVENTS` on `panel.events.v1.<workspace>`), created with `NATS_ENSURE_STREAMS`, and how many days it keeps rows (0, the default: no age limit). Without NATS the collector accepts batches and writes nothing |
| `PANEL_COLLECTOR_URL`, `PANEL_SDK_FILE` | WeldPanel: the collector origin the install snippets point at (default: the request's own origin, which serves the collector too), and the SDK bundle served as `/s.js` (default `/srv/panel/panel.global.js`, which the image carries; missing: `/s.js` answers 404). The day's salt and the daily counts need `VALKEY_URL` across pods |
| `SMTP_URL` | system mail: `smtp://user:password@relay:587?tls=required`, `smtps://…:465` or `smtp://mailpit:1025` (optional; unset skips mail, as the workers without `SEND_EMAIL`) |
| `SYSTEM_EMAIL_FROM` | send from this address instead of `notifications@mail.weldsuite.org` (optional) |
| `SIGN_SESSION_SECRET`, `SIGN_PORTAL_URL` | WeldSign: the key of signer sessions and access-code hashes (the workers' value), and the signer portal's origin for signing links (default `https://sign.weldsuite.org`) |
| `WELDPASS_ROOT_KEY`, `WELDPASS_ROOT_KEY_V2` | WeldPass: the root key that wraps every vault's key (64 hex characters, the workers' value, so either backend opens the other's vaults), and the new one while a rotation is in flight. Unset: the vault routes answer 500 `CRYPTO_ERROR`. Losing it makes every stored secret unrecoverable |
| `COLLAB_ROOMS_URLS`, `COLLAB_ROOMS_SECRET` | WeldDocs and WeldSheets' live editing (`docs/collab-rooms.md`): every collab-rooms pod's URL, comma separated (the chart lists them), and the `x-internal-secret` both ways. A room's calls and its socket go to the pod that wins rendezvous hashing on the room id. Unset: every route that needs a room or an engine (create, import, convert, session, live snapshot, export, versions, connected tables' refreshes) answers 503, and `/config.json` lists `collab-rooms` as unavailable, so the platform hides WeldDocs and WeldSheets |
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
| `PUBLIC_API_URL` | the public API's origin (this host, e.g. `https://app.example.eu`) that the `weld` CLI is told after its device login; unset names Global's `api(-test).weldsuite.org`, as app-api does. The frontends get it from `PUBLIC_ENV`'s `VITE_EXTERNAL_API_URL` |
| `EXTERNAL_API_URL`, `USER_APP_BUNDLE_SIGNING_KEY` (else `INTERNAL_API_SECRET`), `USER_APP_BUNDLE_ORIGIN`, `USER_APP_FRAME_ANCESTORS`, `WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS` | WeldApps: where the app gateway forwards to (the public API at `/v1`; the chart points it at the release's own Service, `config.publicApi.gatewayUrl` overrides), the bundle-link signing secret (the same value as app-api's, so links open on either backend), the dedicated bundle origin, extra `frame-ancestors`, and the workspaces whose apps are first-party (all optional; without a signing secret, private bundles fail closed) |
| `MCP_SERVER_URL`, `OIDC_ISSUER` (else `CLERK_PUBLISHABLE_KEY`) | The MCP server (`/mcp`): the public origin AI clients reach it on, which its OAuth discovery documents name (the chart sets it from `config.mcp.serverUrl`, else the first ingress host), and the authorization server they point at (unset `MCP_SERVER_URL`: `/mcp` answers 503 and no discovery is served) |
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
`WEBHOOK_ALLOW_PRIVATE_NETWORKS`, `WEBHOOK_RETRY_SWEEP`, `CONSUME_DRAIN_SECONDS`,
`RESTATE_INGRESS_URL` for the `weldconnect` subscriber's workflow runs):
the list and the stream layout are in `bins/weldsuite/src/consume/`.
With `S3_BUCKET_MAIL` set it also runs `mail-inbound` (in the default list then;
named in `CONSUME_SUBSCRIBERS` it needs the bucket), on its own stream:
`S3_BUCKET_MAIL` on `S3_ENDPOINT` (the keys and `S3_FORCE_PATH_STYLE` as for
files), `S3_BUCKET_PUBLIC` and `R2_PUBLIC_URL` (else `S3_PUBLIC_URL`) for
attachments and avatars, `NATS_MAIL_INBOUND_STREAM`/`_SUBJECT`/`_DLQ_STREAM`
(`MAIL_INBOUND` on `mail.inbound`, dead letters in `MAIL_INBOUND_DLQ`).

## WeldMeet on LiveKit

Global's meetings run on Cloudflare RealtimeKit; the Kubernetes editions run
them on a LiveKit server (Apache-2.0) that the install provides. Same API,
same call UI:

- **Server.** With `VIDEO_PROVIDER=livekit` (chart: `config.video`) the meet
  module creates rooms over LiveKit's `RoomService`, and the session start
  and join routes answer a LiveKit join token as `authToken`. The token
  follows the RealtimeKit preset it stands for: the host's carries
  `roomAdmin` on its room, a waiting guest's grants nothing and carries the
  `weldsuite.waiting` attribute (`crates/video-rooms/src/livekit.rs`).
  `/config.json` tells the platform `videoProvider: "livekit"` and `videoUrl`
  (`LIVEKIT_URL`). LiveKit's webhook (`/api/webhooks/livekit`) keeps presence
  and ends the session when the room closes.
- **Client.** `@weldsuite/weldmeet-ui/providers/livekit` is a LiveKit client
  (`livekit-client`, pinned) behind the RealtimeKit client surface the
  WeldMeet UI is written against, so the platform's call context, the
  meeting overlay and the meeting portal keep one UI and pick the client by
  provider (`apps/web/platform/lib/video-provider.ts`; the portal by its join
  answer). Global has no `/config.json` and never loads it. Covered: join and
  leave with reconnects, camera, microphone, screen share (with its audio),
  device switching, the participant grid and active speaker, connection
  quality, hand raise, host-control updates and the meeting tools (timer,
  Q&A, breakout rooms) over reliable data packets, the waiting room (the host
  admits with `UpdateParticipant`, rejects with `RemoveParticipant`), host
  mute and remove (`MutePublishedTrack`, `RemoveParticipant` with the host's
  token; the server-side removal and "end for all" go through the meet API
  as on Global), and RNNoise noise suppression (the same `getUserMedia`
  patch). Not on LiveKit, hidden there: recording and transcripts
  (`meet-recordings`, `meet-transcription`), RealtimeKit's live transcript,
  captions, translation, polls and live stream (the tools panel leaves out
  what the client lacks), and background effects (RealtimeKit video
  middlewares). The in-meeting chat is the meet API's, as on Global.
- **Meeting portal (guests).** Its join route mints the guest's LiveKit token
  itself (`@weldsuite/meet-domain/livekit`, the claims above) when it runs
  with `VIDEO_PROVIDER=livekit`, `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
  `LIVEKIT_API_SECRET`, and tells the guest's client where to connect. The
  portal is not part of this chart yet: it reads the tenant databases and
  calls the realtime worker directly (see its `lib/`).

What a cluster needs (the EU cluster has none of it yet; this chart does not
deploy it):

1. A LiveKit server (`livekit/livekit-server`, v1.13 or later for the pinned
   `livekit-client`; the official `livekit/livekit-server` Helm chart, or
   the image as a Deployment). One replica is enough to start; more need
   Valkey (`redis:` in its config) for routing. It needs public UDP for media
   (`rtc.port_range_start`/`_end` or a single `rtc.udp_port` with
   `use_external_ip: true`, or the node's IP), TCP 7881 as the fallback, and
   its HTTP/WebSocket port 7880 behind the ingress as `wss://livekit.<domain>`.
   Run it with `hostNetwork` or a LoadBalancer for the UDP range: media does
   not go through an HTTP ingress.
2. TURN for clients behind strict firewalls: LiveKit's embedded TURN
   (`turn.enabled`, TLS on 443 or 5349 with a certificate for
   `turn.<domain>`), or a coturn next to it.
3. Its config: one API key pair (`keys:`), the same pair in the WeldSuite
   Secret (`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`), and
   `webhook.urls: [https://<weldsuite host>/api/webhooks/livekit]` signed
   with that key (`webhook.api_key`).
4. The chart: `config.video.provider: livekit`, `config.video.livekit.url:
   wss://livekit.<domain>`, and `apiUrl` when the server reaches LiveKit's
   API inside the cluster (`http://livekit.livekit:7880`); the network policy
   must let the server out to it.
5. Recording later is LiveKit Egress (and its own deployment), writing into
   the files store; not built (`meet-recordings`).

Checked locally against `livekit/livekit-server:v1.13.10` (`--config` with
`node_ip: 127.0.0.1`, a webhook to the server) and this server with
`VIDEO_PROVIDER=livekit`: tokens from the session start and join routes,
three Chrome pages on the LiveKit client (host, member, a waiting guest
minted as the portal mints it): media both ways, broadcasts, camera on and
off, the waiting room with admit, host mute and remove, end for all, and the
webhook keeping the session. v1.9 servers are too old for the pinned client
(its `/rtc/v1` signalling and negotiation time out).

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
5. **WeldReach's replies.** Each Mailpool mailbox forwards its mail to
   `reply+<token>@REACH_INBOUND_DOMAIN`; with that domain's MX on Haraka and
   `REACH_INBOUND_DOMAIN` set for `serve` and `consume`, the RCPT check
   accepts the address while master `reach_routes` has an active
   `inbound_token` route for the token, and `consume` hands those
   recipients to WeldReach (`modules/reach/src/inbound`, reach-api's
   `email()` handler) before WeldMail sees the rest: the warmup screen,
   matching, the raw copy in `STORAGE`, the stop, suppression and guardrail
   effects, the CRM hand-off. A message only for WeldReach is removed from
   the spool there; what WeldReach cannot process is parked in `STORAGE`
   (`reach/<org>/_failed/<sha256>.eml`), never retried, as on Global.
   Parity: `modules/reach/tests/inbound_parity.rs` against fixtures
   reach-api wrote (`pnpm rust:reach-inbound-fixtures`, checked in CI).

Differences from Global, on purpose: one delivery per message with every
accepted recipient as the envelope (Cloudflare calls the worker once per
recipient, so its helpdesk and accounting fan-out ran once per recipient);
no consumer WeldMail (MAIL-008), no mailbox Durable Object (MAIL-010), no
Jev auto-labels (Workers AI; mail AI is an unavailable feature). Parity:
`crates/mail-inbound/tests/parity.rs` against fixtures the worker's own code
wrote (`pnpm rust:mail-inbound-fixtures`, checked in CI).

Probes: `/livez` (the process answers), `/readyz` (the master database answers
and the pod is not draining). `/health` keeps the workers' JSON.

Not there yet in the realtime gateway: the whiteboard rooms (Flow's REST
routes are ported, its collaborative rooms are not; WeldDocs' document rooms
run in the collab-rooms service, `docs/collab-rooms.md`), and the
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
