# The connector framework is ours

Status: **accepted** — supersedes "Nango as the connector framework" (2026-07-28).
Date: 2026-07-30
Scope: WeldConnect connectors, first proven on Moneybird.

## Why the previous decision was reversed

Two days of building on Nango surfaced the thing the evaluation missed: **Nango
would have been a second connector system, not the connector system.**

Moneybird is not in Nango's catalog. Neither is Exact, Twinfield, WeFact,
SnelStart, or e-Boekhouden. Every Dutch accounting provider — the ones WeldBooks
actually needs — was going to be a hand-written connector no matter what. So the
choice was never "Nango or build our own". It was "Nango *and* build our own, in
two different shapes" versus "one shape".

The argument that Nango saves the expensive parts still holds, and none of it was
wrong: token refresh quirks, a sync scheduler on a runtime with no persistent
process, per-provider pagination, and provider API drift are the four costs, and
they are real. What tipped the decision is that we were going to pay them anyway
for the providers that matter most to us, and paying them *twice* — once inside
Nango's model and once outside it — is worse than paying them once.

Registering an OAuth app per provider was never a differentiator. Nango uses our
client id and secret for every integration, so the multi-week items — Google's
restricted-scope verification, marketplace review, publisher verification — are
identical under either choice.

## What we actually had: four connector abstractions

The repo did not have "Nango vs the legacy engine". It had four overlapping
things, which is the real reason this consolidation was worth doing:

| Location | Interface | State |
|---|---|---|
| `packages/core/nango` + `app-api/services/nango` | Nango REST client | deleted |
| `integration-webhook-worker/src/lib/engine` | `CrmSyncAdapter` | promoted, see below |
| `app-api/src/lib/integrations` | `CrmSyncAdapter`, a verbatim copy of the above | to delete in phase 2 |
| `integration-webhook-worker/src/lib/integrations` | `IntegrationProvider`, Attio-shaped | to delete in phase 2 |

## Decision 1 — the interface already existed; promote it, don't invent one

`CrmSyncAdapter` was already the right abstraction: OAuth authorize / exchange /
refresh, webhook verify / parse / register / delete, inbound
`fetchEntities(cursor, updatedSince)`, outbound `pushEntity` / `deleteEntity`,
and default field mappings. It was provider-agnostic enough that a *calendar*
implemented it.

It became `ConnectorDriver` in `@weldsuite/connectors` with three changes:

1. **OAuth is declarative.** Every adapter used to implement the same RFC 6749
   code with a different URL. A driver now declares `oauth2` and the shared flow
   runs it; genuine deviations override the hooks.
2. **Optional members are actually optional.** Outbound push, webhooks and field
   mappings are optional. The interface it replaces forced an inbound-only
   provider to write stubs that threw, which is how a shared interface stops
   describing anything.
3. **`DriverContext`, not a bare token.** Moneybird addresses everything under an
   administration id; Salesforce under an instance URL. Per-connection identity
   travels in the context instead of being smuggled through the access token.

**The rule that keeps it honest:** nothing provider-shaped goes into
`ConnectorDriver`. The interface being deleted grew `resolveObjectSlug`,
`fetchLists` and `fetchListEntry` — all three Attio concepts — and then every
other provider carried stubs for them. That is the failure mode to watch for.

## Decision 2 — one entity vocabulary, declared in the schema

There were two sets of names for the same things: the sync engine's
`contact` / `customer` and the older provider layer's `person` / `company`. The
union now lives in `packages/core/db/src/schema/connector-connections.ts` and
`@weldsuite/connectors` re-exports it. The database column is what constrains the
value, so a second declaration in the package would have been free to drift.

## Decision 3 — the scheduler is a queue fan-out, not a serial cron

Nango owned the sync schedule. Replacing it is the substantive new work, and the
existing `integration-sync-worker` sweep was not a sufficient base: it iterated
every workspace and every connection serially inside one cron invocation.

The cron now resolves due connections and enqueues one message per
`(connection, entity)`; a consumer runs one pull per message. Each invocation
stays bounded and Cloudflare's retry + DLQ replaces hand-rolled error handling.

**This is what forced the refresh lease.** With fan-out, several Workers hold the
same connection at once, and a provider that rotates refresh tokens — HubSpot,
Salesforce, Moneybird — will reject the second of two concurrent refreshes. The
connection then drops to `auth_error` with nothing actually wrong and the tenant
is told to reauthorise for no reason. So refreshing is serialised on
`connector_connections.refresh_lock_until`, claimed with a single conditional
`UPDATE`. A read-then-write claim reintroduces the exact race.

## Decision 4 — timing lives in D1, so the cron never opens a tenant database

The first cut of the scheduler kept the old shape: load every workspace from the
master DB, open every tenant's Neon database, ask whether anything was due. That
is wrong at any interval. A tenant with no integrations at all was still woken 48
times a day.

Worth being precise about the cost, because it is not the one people reach for
first: Neon's idle timeout is 5 minutes, so a 30-minute cron does **not** pin a
database awake — it suspends between sweeps. What it does pay is a cold start and
a query per tenant per tick, forever, for tenants that will never have anything
to sync. (The genuinely pinning case is a cron at or under 5 minutes; see the
pool-refill incident.)

So timing moved to a D1 `sync_index` table (`@weldsuite/connectors/sync-index`):
one row per dispatchable unit, holding `next_run_at`, the interval and the
workspace. The sweep does one D1 read and a tenant database is opened only
downstream, where there is real work. This is the same pattern
`workflow-worker`'s `schedule_index` introduced for scheduled workflow triggers,
for the same reason — that header comment says it replaced a fan-out that "kept
all databases perpetually awake".

Three details that matter:

- **Both engines are indexed.** Fixing only the connector half would have changed
  nothing measurable: the legacy `integration_connections` sweep sat in the same
  loop, on the same tick, opening the same databases.
- **`next_run_at` advances at dispatch, not on completion.** Connector rows are
  only queued by the sweep, and a permanently failing sync must not stay due on
  every tick and hammer a provider that is already unhappy.
- **The index is authoritative for *when*, never for *what*.** The tenant row
  stays the source of truth for configuration and history. That split is what
  makes drift safe: a stale row costs one needless dispatch, which the queue
  consumer already acks and discards when the connection is gone or paused, and a
  missing row is repaired by the rebuild.

`POST /internal/sync-index/rebuild` on integration-sync-scheduler is the only
remaining all-tenant fan-out. It backfills from tenant state, is authenticated on
`X-Internal-Secret`, and is invoked by hand — never on a timer. **It must be run
once after this deploys**, or existing connections have no index rows and silently
stop syncing.

## Decision 5 — mapping still reuses `integration_entity_mappings`

Unchanged from the previous decision, and the reason the migration off Nango was
cheap: the ingest pipeline — checksum-based change detection, mapping reuse,
`db.batch()` atomicity, dedup on a natural key — is provider-agnostic and was
kept wholesale. Only the transport was replaced.

Deletes soft-delete the internal row but **keep** the mapping, so a provider
undelete re-links instead of importing a duplicate. Disconnecting keeps both the
imported rows and their mappings — removing a connector must never delete the
customer's data.

## Decision 6 — the checksum is what makes weak providers viable

A driver whose provider offers no `updated_after` filter full-scans instead, and
the checksum turns every unchanged record into a skip rather than a write. This
is why "the provider has no incremental API" is an implementation detail rather
than a blocker, and it is worth keeping even though the third-party delivery
envelope that originally motivated it is gone.

## Shipped in phase 1

`@weldsuite/connectors`, the `connector_connections` / `connector_sync_runs`
schema, the Moneybird driver, the ported ingest, the sync loop, the queue
dispatcher, `/api/connectors/*`, and the public OAuth callback.

**Moneybird is polling-only, deliberately.** It supports webhooks, and each
registered webhook carries a token and a secret documented as being used for
signatures — but the algorithm and header name are not documented anywhere we
could verify. A guessed HMAC fails one of two ways: rejecting every legitimate
delivery, or accepting forged ones. An unverified webhook endpoint is worse than
none here, because anyone who learned the URL could inject invoices into a
tenant's books.

**Moneybird sales invoices are not imported yet.** The driver can fetch them, but
`invoices.entity_id` is NOT NULL and there is no derivable default when a
workspace has more than one accounting entity, and writing rows into the ledger
affects VAT and P&L. Two decisions come first: which accounting entity an
imported invoice belongs to, and whether it posts a journal entry.

**There is no webhook receiver yet.** Routing a provider-pushed change to a tenant
is a decision per provider — Google Calendar uses channel ids, HubSpot puts the
portal id in the body, Attio posts to a fixed URL — and picking one strategy now,
against a provider whose signatures we cannot even verify, would likely be wrong
for all three. It gets written in phase 2 against real providers.

## Still open

- **Phase 2: absorb the legacy engine.** Reimplement Attio, HubSpot and Google
  Calendar as `ConnectorDriver`s, move `field-mapper.ts`, `conflict-resolver.ts`
  and `outbound-calendar-sync.ts` into the package, then delete the three
  remaining abstractions. `pushEntity` / `deleteEntity` already exist on the
  interface, so bidirectional sync needs no widening.
- **Phase 3: retire `integration_connections` for connector use.** It also backs
  MCP server connections and helpdesk channels, so it cannot simply be dropped.
- **Gmail.** Unchanged by any of this: restricted scopes need Google verification
  and a CASA assessment against our own client, which is why Gmail is absent from
  the catalog.

## Configuration

| Variable | Where | Notes |
|---|---|---|
| `CONNECTOR_STATE_SECRET` | app-api secret | HMAC key signing the OAuth `state`. The public callback trusts nothing else. Unset ⇒ the connect flow answers 503 rather than issuing a forgeable state. |
| `MONEYBIRD_CLIENT_ID` / `_CLIENT_SECRET` | app-api secrets | Resolved by convention as `${CONNECTOR_ID}_CLIENT_ID` / `_CLIENT_SECRET`, so a new connector is two secrets and no code change. |
| `CONNECTOR_OAUTH_REDIRECT_ORIGIN` | app-api var | A connect request's `redirectUri` must start with this. Unset disables the check; an unvalidated redirect hands the authorization code to whoever asked. |
| `PUBLIC_APP_URL` | app-api var | Where the OAuth callback sends the browser back to. Already existed. |

Provider-side setup: register an OAuth app with each provider and point its
callback at `https://app-api.weldsuite.org/public/connectors/oauth/callback`.
