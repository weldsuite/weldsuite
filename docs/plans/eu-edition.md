# EU edition, Rust backend and self-hosting

Status: **Proposed** (2026-10-28). Nothing in this plan is built yet.
Owner: Gert van den Berg.

Decisions: ADRs [OPS-012](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/OPS-012-three-deployments-of-one-product.md)
(editions), [API-014](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/API-014-one-rust-backend.md)
(Rust backend), [OPS-013](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/OPS-013-one-image-kubernetes-and-cloudflare-containers.md)
(runtime), [OPS-014](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/OPS-014-self-hosted-distribution.md)
(self-hosting) and [SEC-012](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/SEC-012-identity-behind-an-oidc-port.md)
(identity). All are *Proposed*. Design doc:
[Editions and self-hosting](https://github.com/weldsuite/weldsuite-documentation/blob/main/design/platform/editions-and-self-hosting.md).

## Goal

Ship WeldSuite in three ways from one codebase:

| Deployment | Who it is for | Where it runs |
|---|---|---|
| **Global** | Everyone who doesn't need EU sovereignty | Today's vendors: Cloudflare, Neon, Clerk, Stripe |
| **EU** | Government, healthcare, finance, and anyone whose DPA requires EU-only processing | Hetzner now, WeldSuite's own servers later; EU companies or self-run open source only |
| **Self-hosted** | Customers who run WeldSuite on their own servers | Wherever the customer puts it. WeldSuite's own servers are the first install. |

The backend becomes **one Rust service**, shipped as **one container image**, that
runs in all three. Today's 46 TypeScript workers are ported to it module by
module and deleted as each module moves.

## Decisions taken (2026-10-28)

1. **Two hosted editions, no shared runtime data.** Each edition has its own
   master database, logins, billing and domain. The edition is chosen at signup.
   Moving between editions is an export and import.
2. **The EU edition is dormant until the first EU customer signs.** Until then
   it costs only CI time, plus a monthly drill that builds the cluster from
   scratch, smoke-tests it and tears it down again.
3. **EU runs on Hetzner first, then on WeldSuite's own servers.** Provider-managed
   services that would force a second migration are out: no managed Kubernetes,
   no managed Postgres. Everything runs from the same Helm chart a customer uses.
4. **One Rust backend for every deployment.** No permanent second backend, and
   every feature is built once.
5. **Global runs the Rust image on Cloudflare Containers** next to Neon in
   Frankfurt, with Cloudflare's edge in front. EU and self-hosted run it on
   Kubernetes.
6. **Self-hosting covers both** customer installs and moving the EU edition to
   own servers. It is one distribution.
7. **No people costs in estimates.** The engineering is done in-house.
8. The company is a Dutch BV. The work is a WBSO candidate: file before the
   period starts (realistically from 1 January 2027), then claim the innovation
   box on the resulting profit.

## Non-goals

- Changing the product. Features, permissions and API paths stay as they are.
  A ported endpoint returns byte-for-byte compatible JSON.
- Rewriting the frontends. The platform SPA, the portals and the mobile apps
  stay TypeScript. They gain an auth facade and runtime config, nothing more.
- A shared user directory across editions. It would put EU users' email
  addresses on US infrastructure.
- Air-gapped installs in the first release (see "Later").

## Scale of the port

Backend TypeScript today, excluding tests (2026-10-28):

| Code | Lines |
|---|---|
| `apps/workers/*` (46 workers) | ≈ 373k |
| `packages/domains/*` + `packages/core/worker-kit` | ≈ 104k |
| **Total** | **≈ 477k** |
| `packages/core/db/src/schema` (stays TypeScript, see "Schema") | ≈ 31k |

The biggest pieces are `books-api` (64k), `app-api` (34k), `workspace-worker`
(25k), `mcp-server` (22k), `connect-api` (17k), `hr-api` (15k),
`external-api` (15k) and `billing-worker` (14k).

This is a multi-year port for one engineer. Two things make it workable:

- **It ships in slices.** Each module moves on its own, and Global keeps working
  the whole time. Nothing waits for the end.
- **Agents do the porting against an oracle.** The conformance suite (below)
  turns every port into "make these recorded responses match". Claude Code
  agents work that loop well.

Rule for feature work during the port: a module gets features in exactly one
language at a time. Before it is ported, it gets TypeScript only. While it is
being ported, it gets no new features (keep that window short). Once it is
ported, it gets Rust only.

## Target architecture

### The Rust backend

A Cargo workspace inside the monorepo, at `rust/`:

```
rust/
  Cargo.toml                  workspace
  crates/
    kit/                      what @weldsuite/worker-kit is today: app builder,
                              request pipeline, envelope, errors, ids, pagination
    ports/                    the traits every adapter implements (table below)
    adapters-cloudflare/      Global: bindings reached through outbound Workers
    adapters-oss/             EU + self-host: Postgres, Valkey, NATS, Restate, S3, OIDC …
    db/                       sqlx models over the existing schema, tenant pool manager
    catalogs/                 generated from the TS catalogs at build time (see below)
    ai/                       OpenAI-compatible client + the native Anthropic route
    modules/<module>/         one crate per weld* module: routes, services, consumers
    core/                     what app-api owns today
  bins/
    weldsuite/                the one binary: `serve`, `consume`, `cron <job>`,
                              `migrate`, `workspace export|import`, `doctor`
```

- **Stack:** axum + tower on tokio, sqlx (Postgres, compile-time checked
  queries, offline mode in CI), serde, utoipa (OpenAPI), jsonwebtoken with JWKS
  caching, the official `rmcp` crate for the MCP server, tracing +
  OpenTelemetry.
- **One binary, several roles.** `weldsuite serve` runs the HTTP API (all
  modules, one process). `weldsuite consume` runs event consumers and durable
  jobs. `weldsuite cron <job>` runs one scheduled job and exits. Kubernetes
  scales each role as its own Deployment or CronJob from the same image.
- **Modules stay separated in code.** One crate per module. Crates never depend
  on each other's internals, only on `kit`, `ports`, `db` and shared domain
  crates. This is the Rust form of API-004, enforced by Cargo's dependency
  graph instead of a convention.
- **Paths don't change.** The Rust server serves the same `/api/<object>` paths
  and the same envelope (API-006). The ownership manifest in
  `packages/core/api-modules` gains a runtime field per module (`ts` or
  `rust`), so the clients (FE-004) and the app-api forwarder (API-003) send each
  path to whichever runtime serves it today.

**Request pipeline** (the Rust form of `apiAuth()`, as tower layers in order):
request id and tracing → token verification (OIDC JWT against the edition's
JWKS) → workspace resolution (master DB, cached) → tenant pool checkout →
permissions from the tenant DB (SEC-002) → licence gate (SEC-007) → feature
flags → handler → entity event publish after the write (EVT-002).

**Tenant databases.** Today each request opens a Neon HTTP connection. Rust
holds real Postgres connections, and Postgres connections are per database, so:

- A pool manager keeps one small sqlx pool per *active* workspace database,
  evicted LRU, with a global connection cap.
- Every edition puts a transaction-mode pooler in front: Neon's pooler in
  Global, the CloudNativePG `Pooler` (PgBouncer) in EU and self-hosted.
- Prepared statements must work through transaction pooling: use sqlx's
  unnamed statements, or PgBouncer ≥ 1.21 with `max_prepared_statements`.
- Provisioning a workspace database sits behind a `DatabaseProvisioner` port:
  Neon's API in Global, `CREATE DATABASE` on a CloudNativePG shard in EU and
  self-hosted. Shard placement (DATA-016) works the same in both.

### Ports and adapters

Every edition-specific dependency sits behind a trait in `crates/ports`.

| Port | Global adapter | EU + self-host adapter |
|---|---|---|
| Identity | Clerk JWTs (JWKS) + Clerk Backend API | Zitadel, or any OIDC provider the customer brings |
| Tenant + master DB | Neon over TCP through its pooler | CloudNativePG + PgBouncer, or the customer's Postgres |
| DB provisioning | Neon API | `CREATE DATABASE` on a shard |
| Files | R2 through the S3 API | Any S3 API: Hetzner Object Storage, Garage, Ceph RGW |
| Cache | KV through an outbound Worker | Valkey (BSD-licensed Redis fork) |
| Events (EVT-001 hub + subscribers) | Queues through an outbound Worker | NATS JetStream |
| Durable jobs (today ≈ 26 Workflows) | Cloudflare Workflows through an outbound Worker | Restate |
| Schedules (today 45 crons) | Cron Triggers on the front Worker | Kubernetes CronJobs |
| Realtime (today 31 DO classes) | Durable Objects stay in Global (`realtime-worker`) | WebSocket gateway in `weldsuite serve` + Valkey pub/sub |
| Background work (`waitUntil`) | Tracked tasks, drained on shutdown | Same |
| System email out | Cloudflare Email Service | EU sending service (Scaleway TEM or Brevo); SMTP for self-host |
| Mail in | Email Routing → mail-inbound | Haraka MX → `weldsuite consume` |
| Video | RealtimeKit | LiveKit |
| AI | AI Gateway, OpenAI-compatible endpoint (AI-010) | Mistral, or any OpenAI-compatible endpoint (vLLM, Ollama) |
| Workspace agents | Claude Managed Agents | Not available at EU launch (see "Gaps") |
| Payments | Stripe | Mollie (EU); none on self-host (licence file) |
| Telephony | Telnyx | sipgate; customer's own SIP trunk on self-host |
| Feature flags | Flagship binding | Flags in the master DB |
| Push notifications | Expo push | Content-free push through a WeldSuite relay, or off |

**Global reaches Cloudflare services through outbound Workers.** A container
has no bindings of its own. Since March 2026, an outbound handler
(`outboundByHost` in `@cloudflare/containers` ≥ 0.2.0) intercepts the
container's HTTP calls to virtual hostnames and runs them in the Workers
runtime, where every binding is available. The Global adapters are plain HTTP
clients to hosts such as `http://kv.internal/…` and `http://queue.internal/…`.
A small TypeScript Worker, `edge-gateway`, maps those hosts onto the bindings.
Secrets that only the Worker needs stay in the Worker. Queues isn't named in
the outbound-Workers docs, so verify it in milestone M1. If it doesn't work,
fall back to the Queues HTTP API.

### Shared catalogs

Several sources of truth are TypeScript today. The Rust backend needs them too.
During the port they stay TypeScript, and a build step exports them to JSON,
from which `crates/catalogs` generates Rust types in `build.rs`:

| Catalog | Source |
|---|---|
| Entity events (EVT-003) | `packages/core/entity-events/src/events/` |
| Permissions and app grants | `packages/core/permissions/src/catalog.ts`, `app-catalog.ts` |
| Path ownership | `packages/core/api-modules/src/index.ts` |
| Feature flags | the typed flag catalog (SEC-008) |
| Server-side strings | `packages/core/i18n/src/locales/{en,nl}/` (only what the server renders) |
| System email templates | `packages/core/emails`: React Email pre-renders each template to HTML with placeholders at build time, and Rust fills them with minijinja |

CI fails when the exported JSON and the TypeScript disagree.

### API contracts

The frontends depend on the Zod schemas in `@weldsuite/app-api-client` and
`@weldsuite/core-api-client` (API-006).

- **During the port**, Zod stays the contract. The conformance suite validates
  every Rust response against the Zod schema of the TypeScript route it
  replaces.
- **After a module is ported**, Rust becomes the source: utoipa emits OpenAPI,
  and a generator writes the Zod schemas and TS types back into the client
  packages under the same names. Frontend imports don't change.

### Schema and migrations

- The Drizzle schema in `packages/core/db/src/schema` stays the owner of the
  schema and of the generated SQL migrations for as long as TypeScript code
  touches the database. The migration rules in `CLAUDE.md` are unchanged.
- `weldsuite migrate` applies the same journaled SQL files
  (`packages/core/db/drizzle/{master,tenant}-migrations`), so EU and self-hosted
  installs don't need Node. The TypeScript runner in `apps/tools/migrate-databases`
  stays for Global until the port is finished.
- sqlx query checking runs against a database built from those migrations, so a
  migration that breaks a Rust query fails CI.
- Moving the schema source out of TypeScript is a separate decision, made after
  the last TypeScript backend code is gone.

## Deployments

### Global: Cloudflare Containers

```
browser / mobile ─▶ Cloudflare edge ─▶ edge-gateway (Worker)
                                          ├─ ported paths ─▶ Container: weldsuite serve ─▶ Neon (Frankfurt)
                                          │                    └─ outbound ─▶ KV, Queues, Workflows, DO, Email
                                          └─ unported paths ─▶ TS module workers (as today)
```

- **Always warm.** Cold starts take 1–3 s, so the API keeps a minimum number of
  instances awake. Scale-to-zero is for `cron` and `consume` roles only.
- **Sizing.** All modules run in one Rust process, so 2–3 `basic` instances
  (¼ vCPU, 1 GiB) are the starting point: about $25–35 a month at list price
  (memory is billed provisioned, CPU active). Load-test before cutover.
- **Placement is the main risk.** Cloudflare starts a container near the request
  that wakes it, and the docs offer no way to pin a region. The API must sit
  next to Neon in Frankfurt, because one API call makes several queries. M1
  measures where instances land and how long a query takes from there.
  **Fallback:** run Global's containers on a small Hetzner cluster in
  Falkenstein (a few ms from Neon's eu-central-1) behind the same Cloudflare
  edge, using the EU Helm chart with the Global adapters.
- Realtime stays on Durable Objects in Global. The Rust API publishes to
  `realtime-worker` through an outbound host.

### EU: Kubernetes on Hetzner, then own servers

The cluster design comes from the October 2026 sizing work:

- **Kubernetes:** Talos (or k3s) across Falkenstein (FSN1) and Nuremberg (NBG1),
  with a small Helsinki (HEL1) node as etcd tie-breaker. Placement groups,
  `topologySpreadConstraints` across locations and racks, PodDisruptionBudgets.
  Every stateless role runs at least two replicas in two locations.
- **Postgres:** CloudNativePG on a dedicated node pool with local NVMe (no Cloud
  Volumes, so failover never needs the Hetzner Cloud API). Primary and synchronous
  replica in different locations. PgBouncer `Pooler`. WAL archiving and base
  backups to a second EU provider.
- **Files:** Hetzner Object Storage, replicated to a second location or EU
  provider. Hetzner object storage was degraded for about 145 hours in August
  2026, so one location alone isn't enough.
- **In the cluster:** Valkey, NATS JetStream (3 nodes), Restate, Zitadel, LiveKit
  (+ TURN), Haraka MX, CoreDNS forwarding to an EU resolver (DNS4EU or Quad9)
  instead of Hetzner's resolvers.
- **Edge:** Bunny.net (Slovenia) for the SPA and static assets, and DNS failover
  between locations. No US CDN in the EU path.
- **Outside the cluster:** an EU email sending service (kept even on own
  servers: deliverability needs a reputable sending IP pool), Mistral, Mollie,
  sipgate.
- **Infrastructure as code:** OpenTofu for servers, networks and DNS. GitOps
  (Flux) pulls releases from an EU container registry, so GitHub never holds EU
  credentials.
- **Expected uptime:** ≈ 99.95% across two locations. Rack switch faults (five
  in six days in July 2026) are survived by the spread. A Hetzner Cloud API
  outage (3.6 h in July 2026) blocks scaling, not serving.
- **Running cost** (estimates, Hetzner list prices): dormant ≈ €70/month
  (registry, backups, drill), launch ≈ €310/month, 10× ≈ €1,300/month.

**Dormant mode.** Until the first EU customer signs:

- CI builds and tests the EU adapters on every PR (testcontainers: Postgres,
  Valkey, NATS, Restate, Zitadel, an S3 server).
- A monthly drill runs OpenTofu + Flux against Hetzner, restores the latest
  test backup, runs the smoke suite and tears everything down. It also checks
  that the server types are actually available (Hetzner has listed "limited
  availability of cloud instances" since April 2026) and falls back to other
  types or locations when they aren't.
- Lead time from signed contract to production: target two weeks.

**Moving to own servers** is a self-hosted install with WeldSuite as the
customer (next section). What changes compared with Hetzner:

- Servers come from Talos on bare metal (PXE or ISO) instead of the Hetzner
  OpenTofu module.
- The load balancer becomes MetalLB with BGP or keepalived.
- The object store becomes Garage across the nodes, or stays at an external EU
  S3 provider.
- A second site is needed for the same uptime as two Hetzner locations.
  Colocation in two Dutch datacentres is the obvious shape.
- Email sending stays with the external EU service.

### Self-hosted

#### What a customer gets

- **Container images**, multi-arch (amd64 and arm64), signed with cosign, with
  an SBOM, published to WeldSuite's EU registry.
- **One Helm chart**, `weldsuite`, the same chart the EU edition runs. Every
  dependency is a toggle: bundled (CloudNativePG, Valkey, NATS, Restate,
  Zitadel, Garage, LiveKit, Haraka) or external (bring your own Postgres, S3,
  OIDC provider, SMTP relay, TURN).
- **The web apps served by the backend.** In self-hosted installs `weldsuite
  serve` also serves the platform SPA and the portals' static builds from the
  image, so a single hostname works. A CDN in front is optional.
- **`weldsuite` admin commands:** `doctor` (checks DNS, TLS, mail ports, S3,
  OIDC, DB), `backup` and `restore`, `workspace export|import`, `licence show`.
- **An install path for one machine:** a script that installs k3s and the chart
  with the single-node profile. Helm is the only supported packaging, so there
  is one thing to test. No separate Docker Compose distribution.

#### Sizing guidance (to be confirmed by load tests)

| Profile | Users | Hardware |
|---|---|---|
| Single node | up to ≈ 50 | 4 vCPU, 16 GB RAM, 200 GB SSD, no HA |
| Small HA | up to ≈ 500 | 3 nodes × 4 vCPU / 16 GB, plus Postgres on 2 nodes with NVMe |
| Large | 500+ | Same as the EU edition's production cluster |

#### Changes the platform needs for self-hosting

- **Runtime configuration for the web apps.** Today the SPA reads `VITE_*`
  variables at build time (for example `VITE_API_MODULES`). A customer can't
  rebuild the SPA, so it loads `/config.json` from the server at startup: API
  origin, OIDC issuer and client id, edition, enabled modules and features.
  Global uses the same mechanism.
- **Auth facade.** One `lib/auth` in the platform (and the same in the mobile
  template) replaces direct `@clerk/clerk-react` / `@clerk/expo` imports
  (≈ 198 web files and ≈ 57 mobile files today). It is backed by Clerk in Global
  and by a generic OIDC client (PKCE) elsewhere.
- **Mobile apps** ask for a server address at sign-in ("WeldSuite cloud" or
  "your own server"), discover OIDC from it, and receive push only through the
  content-free relay. The same store builds serve all three deployments.
- **Workspace = organisation in the OIDC provider.** SEC-001 ties a workspace to
  a Clerk organization. The identity port maps it to a Zitadel organization, and
  for a bring-your-own provider to a group claim. Membership and roles stay in
  WeldSuite's databases (SEC-002), so the provider only has to authenticate.
- **TLS for custom domains** (help centre, sites, booking pages): cert-manager
  with ACME (HTTP-01) in the chart.

#### Features that depend on WeldSuite-run services

| Feature | Self-hosted behaviour |
|---|---|
| WeldHost domain registration | Off. DNS can still be managed when the customer brings a supported DNS API. |
| WeldMail free `{slug}.weldmail.com` addresses | Off. Own domains only. Needs inbound port 25 and an outbound relay. |
| WeldData lead database (WeldSuite's provider key) | Off, unless the customer brings their own provider key. |
| AI features | The customer's own OpenAI-compatible endpoint and key: Mistral, a local vLLM or Ollama, or Azure. Off when none is set. |
| Workspace agents (WeldAgent) | Off at first. Same gap as EU. |
| Integrations (Google, Microsoft, Slack, …) | The customer registers their own OAuth apps. The admin UI shows the redirect URLs. |
| WeldApps store | Private apps work. The public store is optional and pulls signed bundles from WeldSuite's registry. |
| Billing and credits | No Stripe. Seats and modules come from the licence. AI usage is metered for display only. |
| Push notifications | Through WeldSuite's content-free relay (opt-in), or off. |
| Telephony | The customer's own sipgate or Telnyx account, or their SIP trunk. |
| Video | Bundled LiveKit. Needs UDP ports, or TURN over TCP 443. |

#### Licence and business model

- The platform stays **AGPL-3.0** (OPS-002). Anyone may self-host it for free
  under the AGPL. That is the community edition, with community support.
- **WeldSuite Self-Hosted (commercial)** is sold under a commercial licence,
  which the CLA allows. It comes with support, security updates on an LTS
  channel, and no AGPL obligations for the customer's own modifications.
- **Licence file:** a signed token (Ed25519) that is verified offline. It holds
  the customer, seats, modules, support tier and expiry. It feeds the existing
  licence gate (SEC-007). After expiry there are 30 days of grace, then
  read-only. No phone-home is required.
- The licence check is a commercial control, not DRM. AGPL code can be patched,
  and that's fine: paying customers pay for support, updates and the licence
  terms. There is no proprietary `ee/` folder at first. Revisit if a feature
  must be paid-only on self-host.
- Partners (BILL-008) can sell and run self-hosted installs for their own
  customers on the same licence model.

#### Updates and support

- **Channels:** `stable` (monthly) and `lts` (one release a year, with security
  fixes for 12 months). Images are tagged with the release version.
- **Upgrades:** `helm upgrade` runs `weldsuite migrate` as a pre-upgrade Job.
  Migrations are forward-only, and the chart refuses an upgrade that skips more
  than two minor releases. `weldsuite backup` runs first by default.
- **Telemetry:** off by default. An opt-in anonymous heartbeat (version, seat
  count) helps prioritise support.
- **Observability:** Prometheus metrics, OpenTelemetry traces, JSON logs, and
  `/healthz` and `/readyz` on every role.

## Editions in the product

- **Signup chooses the edition.** The sign-up page asks where the workspace
  should live and sends the user to that edition's domain. A person who works in
  both has two accounts.
- **Moving a workspace** between Global, EU and a self-hosted install uses one
  format: `weldsuite workspace export` writes the tenant DB dump, the files under
  `workspaces/<id>/` and a manifest. `import` restores it and re-invites the
  members. It is built on the DATA-016 move workflow (lock the workspace, copy,
  switch). The same command takes a customer from the cloud to self-hosted and
  back.
- **Integrations that leave the EU** (Plaid, HubSpot, Google, Slack, …) stay
  available in the EU edition. They are labelled as leaving the EU and are off
  by default. The workspace admin decides.
- **Push notifications in EU carry no content.** They say "New message", and
  the app fetches the rest.
- **Edition flags in the UI** hide what an edition lacks (for example
  WeldAgent in EU), driven by `/config.json`.

## Milestones

Each milestone ships on its own, and Global keeps working throughout.

| # | Milestone | Done when |
|---|---|---|
| M0 | **Decisions and funding** | ADRs accepted. WBSO application filed for 2027. Conformance approach agreed. |
| M1 | **Rust foundations** | `rust/` workspace in CI (fmt, clippy, tests, sqlx offline). `kit`, `ports`, `db` pool manager, envelope, errors, entity-event publish, catalogs export. `edge-gateway` with outbound hosts, Queues verified. One container deployed to Global test. Placement and Neon latency measured; Containers or the Hetzner fallback chosen. |
| M2 | **Conformance suite** | The TypeScript worker tests record request/response pairs (pglite) into golden files. A runner replays them against `weldsuite serve` on Postgres (testcontainers) and validates against Zod. Reports per module. |
| M3 | **Pilot modules** | `know` and `sign` (small, few dependencies) ported, passing conformance, serving Global test, then production through the ownership manifest. TypeScript workers deleted after two weeks without errors. |
| M4 | **Core platform** | What `app-api` and `workspace-worker` own: workspaces, members, roles, settings, files, search, notifications, custom objects, provisioning (Neon + CNPG provisioners), licence gate. Auth facade and `/config.json` in the platform and mobile template. |
| M5 | **EU adapters and chart** | Zitadel, Valkey, NATS, Restate, S3, LiveKit, Haraka, Mollie, Mistral, TEM adapters. Helm chart with bundled and external toggles. OpenTofu for Hetzner. GitOps from the EU registry. First monthly drill passes. |
| M6 | **EU launch set** | Core plus CRM, Flow, Desk (with widget API), Mail (with inbound), Calendar, Chat, Know, Pass ported. The EU edition can be switched on within two weeks of a signed customer. |
| M7 | **Self-hosted 1.0** | Signed images and chart published, licence files, `doctor`, `backup`, `workspace export/import`, install script, sizing tested, upgrade path tested from the previous release. WeldSuite's own servers run as install #0 when hardware is in place. |
| M8 | **Remaining modules** | Books, Commerce, Stash, Connect (with the workflow engine on Restate), HR, Reach, Social, Ads, Data, Meet, Call, Sheets, Host, the public API, MCP and the remaining workers. Each TypeScript worker is deleted when its module is done. |
| M9 | **TypeScript backend retired** | No backend TypeScript left except `edge-gateway` and `realtime-worker` in Global. Decide where the schema source lives. |

The order inside M8 follows customer demand. A module an EU customer needs
jumps the queue.

## Gaps and risks

- **Port size.** About 477k lines. Mitigated by slicing, the conformance oracle
  and agent-driven porting. Revisit the plan if M3 takes longer than three
  months.
- **No EU module before M6.** If an EU customer signs before M6, launch with the
  modules that are ported, or hold the contract. Running TypeScript modules in
  Node containers in the EU is ruled out: it would mean building and keeping a
  second set of adapters.
- **Global container placement.** See the Global section. Fallback: Hetzner in
  Falkenstein behind Cloudflare.
- **Tenant connections.** Thousands of workspace databases against a pooler, with
  per-database pools. Load-test the pool manager in M1 with a realistic count of
  active workspaces.
- **Engines shared with the browser.** `sheets-engine`, `docs-engine` and
  `collab` run in the browser and in Durable Objects. Options: keep the server
  side in TypeScript behind a sidecar, or port the engine to Rust and compile it
  to WASM for the browser too. Decide when WeldSheets is next in line.
- **Workspace agents in EU and self-hosted.** Claude Managed Agents is a US
  service with no sovereign twin. An EU agent runtime needs its own agent loop on
  Mistral, plus a sandbox (for example Firecracker or gVisor in the cluster).
  It is planned as its own project, after M6.
- **AI parity.** `@weldsuite/ai` uses the Vercel AI SDK. The Rust `ai` crate
  covers the OpenAI-compatible endpoint (AI-010) and the native Anthropic route
  (AI-009). Model fallback (AI-004) and charging the model that served (AI-005)
  must carry over unchanged.
- **Email deliverability** from own servers is hard. Keep an external EU sending
  service. Self-hosters configure an SMTP relay.
- **Two authentication systems.** Clerk in Global and OIDC elsewhere must give
  the same membership and permission results. Conformance runs the auth tests
  against both.

## What to update in the docs repo as this lands

- Supersede `API-001` and `API-005` with `API-014` when it is accepted.
  `API-003`, `API-008` and `FE-004` gain the runtime dimension.
- Amend `SEC-001` through `SEC-012` (a workspace maps to an organisation in any
  OIDC provider).
- Update `design/platform/api-architecture.md`, `ci-cd-and-infrastructure.md`,
  `identity-and-access.md` and `overview.md` as each milestone lands.

## Later

- Air-gapped installs: an offline bundle of images, chart and app store, and a
  licence that never needs the network.
- A managed single-tenant edition (a dedicated cluster per customer, run by
  WeldSuite), built on the self-hosted chart.
- Forgejo instead of GitHub for the EU edition's source and CI.
