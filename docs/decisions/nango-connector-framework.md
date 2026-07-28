# Nango as the connector framework

Status: **accepted** — start on Nango Cloud, keep self-hosting one env var away.
Date: 2026-07-28
Scope: WeldConnect connectors, first proven on Salesforce + HubSpot → WeldCRM.

## Context

WeldSuite needs third-party connectors: OAuth, token storage and refresh, sync,
and webhooks, across many providers. Building that per provider is what the
legacy CRM sync engine does today (`apps/workers/integration-webhook-worker`,
one hand-written adapter per provider), and it does not scale past a handful.

Nango is code-first, covers 500+ APIs, is usage-priced with no platform fee, and
is open source and self-hostable. The decisive property is that **credentials
stay exportable**: replacing Nango later is a migration we run, not a
re-authorisation we impose on every customer.

## Decision 1 — Nango Cloud first, self-hosting deliberately deferred

The task framed self-hosting as the default because customer tokens then stay in
our systems. That argument is real, and it is why the escape hatch is built in
from day one. It is not, however, where the first connectors should start.

**Self-hosted Nango cannot run on the Cloudflare stack.** It is a long-running
Node server plus PostgreSQL, Redis, and (for logs at any useful retention)
Elasticsearch or OpenSearch. Workers have no persistent process, no Redis, and
no place to run Temporal-style sync schedulers. Self-hosting therefore means a
new box — the honest ops cost, before anyone has connected a single account:

| Item | Reality |
|---|---|
| Compute | A VM or container platform we currently do not operate. Nothing else in WeldSuite runs this way. |
| Datastores | Postgres (separate from Neon), Redis, and a search store for logs. |
| On-call | Connector downtime becomes our incident, including the OAuth refresh path. A missed refresh window silently breaks every tenant on that provider. |
| Upgrades | Nango ships fast; provider templates land in new versions. Falling behind means fixing provider drift ourselves — exactly the work we adopted Nango to avoid. |
| Security | We inherit custody of every customer's third-party tokens, and the review burden that comes with it. |

That cost buys one thing today: an answer to an enterprise security question we
have not yet been asked. The sequencing is therefore: prove the connector layer
on Cloud, and self-host when a deal actually requires it.

**What makes the switch cheap.** Nothing above `NangoClient` knows where Nango
runs. The client takes a `host`, `packages/core/nango/src/client.ts` defaults it
to `https://api.nango.dev`, and `NANGO_HOST` / `NANGO_CONNECT_URL` override it.
Moving to self-hosted is: stand up the server, export connections from Cloud,
import them, repoint two env vars, redeploy. No code change, no customer
re-authorisation.

**Revisit when** an enterprise security review blocks a deal on token custody, or
Cloud usage cost exceeds roughly the fully-loaded monthly cost of the box plus
the on-call it creates.

## Decision 2 — connections are per workspace, not per user

Every Connect session is stamped with `organization.id = <Clerk org id>` and
`end_user.id = <Clerk user id>`. The organisation stamp is what makes a
connection a workspace asset:

- A synced HubSpot company belongs to the workspace, not to whoever clicked
  "Connect". Per-user connections would mean an employee leaving silently breaks
  the CRM import.
- Sync webhooks carry only `(providerConfigKey, connectionId)`. The workspace is
  recovered from a KV mapping written when the connection is authorised
  (`nango:conn:<providerConfigKey>:<connectionId>` → Clerk org id).
- `nango_connections` has a unique index on `providerConfigKey`, so one
  workspace holds at most one live connection per integration. Reconnecting
  reuses the row, which keeps every `integration_entity_mappings` row valid and
  turns a reauth into an update rather than a duplicate import.

The end-user id is still recorded (`connectedBy`) and becomes the owner of
imported opportunities, so attribution survives without making access personal.

## Decision 3 — sync is Nango-scheduled, webhook-driven, incrementally applied

- **Nango owns the schedule.** Its syncs run on their own cadence; WeldSuite does
  not poll. `integration-sync-worker`'s cron sweep stays limited to the legacy
  `integration_connections` providers and never touches Nango connections.
- **Webhooks drive ingest.** A `sync` webhook tells us which model changed; we
  then pull the changed records through `GET /records` with a `modified_after`
  watermark. Records are not read from the webhook body, so a large sync is
  paged rather than delivered in one payload.
- **Incremental by default, full resync on request.** The per-model watermark
  lives in `nango_connections.sync_watermarks` and only advances on a run that
  read every page **and** imported every record — a run truncated by the page
  ceiling, or one where any record failed (`partial`), leaves it untouched. Both
  cases are records the next run must re-read; advancing past them would drop
  them permanently, since the provider has no reason to touch them again. The
  cost of not advancing is a re-read the checksum turns into a skip. `finishSyncRun`
  enforces the status half of this independently of its callers. "Full resync"
  in the UI sets Nango's `full_resync`.
- **Re-delivery is cheap.** Every record is checksummed (excluding Nango's
  `_nango_metadata` envelope, whose cursor changes on every delivery) and
  compared against `integration_entity_mappings.sync_checksum`; unchanged
  records are skipped, not rewritten.
- **One bad record does not fail a page.** Failures are counted, sampled onto the
  run row, and the rest of the page proceeds.

## Decision 4 — mapping reuses `integration_entity_mappings`

Nango-synced records map through the same table the legacy CRM adapters use.
Two engines, one mapping table, so an entity imported by either is deduped
against the same rows and a future migration off the legacy adapters does not
have to reconcile two histories.

Deletes soft-delete the internal row but **keep** the mapping, so a provider
undelete re-links instead of importing a duplicate. Disconnecting a connector
keeps both the imported rows and their mappings — removing a connector must
never delete the customer's CRM data.

## Out of scope — Gmail

Nango uses *our* OAuth client, so Gmail still requires Google restricted-scope
verification and a CASA Tier 2 assessment. Adopting Nango does not change that,
and Gmail is deliberately absent from the connector catalog. The three options
(bring-your-own OAuth client for enterprise, Aurinko at ~$1/mailbox/month as a
bridge, or CASA ourselves with `gmail.modify` rather than full
`mail.google.com`) are tracked separately.

## Still open

- **Which connector comes after Salesforce and HubSpot.** Driven by actual
  pipeline requests, not catalogue count. The catalog is deliberately restricted
  to connectors with a mapper, so "visible in the UI" and "safe to connect" mean
  the same thing — adding one is an entry in
  `packages/core/nango/src/catalog.ts` plus a mapper.
- **Outbound sync (WeldSuite → provider).** Everything here is inbound. Nango
  supports actions for writes; nothing depends on that yet, and two-way sync
  needs a conflict-resolution decision the legacy engine answers with
  `integration_sync_conflicts`.

## Configuration

| Variable | Where | Notes |
|---|---|---|
| `NANGO_SECRET_KEY` | app-api secret | Server-side only. Never reaches a browser — the Connect UI gets a short-lived session token instead. Unset ⇒ connector routes answer 503 and nothing else changes. |
| `NANGO_WEBHOOK_SECRET` | app-api secret | HMAC key for `X-Nango-Signature`. Unset ⇒ **every** webhook is rejected; there is no development bypass. |
| `NANGO_HOST` | app-api var | Defaults to `https://api.nango.dev`. The self-hosting switch. |
| `NANGO_CONNECT_URL` | app-api var | Defaults to `https://connect.nango.dev`. |

Nango-side setup: create one integration per catalog entry, using the catalog's
`providerConfigKey` as the integration's unique key, and point the environment's
webhook URL at `https://app-api.weldsuite.org/public/nango/webhook`.
