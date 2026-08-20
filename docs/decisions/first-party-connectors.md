# First-party connectors (WooCommerce first)

Status: **accepted** — replace Nango with in-house connector clients.
Date: 2026-08-19
Supersedes: `nango-connector-framework.md`

## Context

WeldConnect connectors were built on Nango Cloud (OAuth, token refresh, scheduled
sync, webhooks). That kept credentials off our Workers stack, but it also meant
every integration was shaped by Nango's models, Connect UI, and webhook contract.
We want to own the connector layer: credentials, sync, and per-connection
settings live in WeldSuite.

## Decision

Connectors are first-party. Each provider is a catalog entry plus a client we
call ourselves. Credentials are stored encrypted on `connector_connections`.
The tenant chooses **on the connection** which objects to sync (products,
orders, customers, …).

WooCommerce is the first connector: store URL + REST API consumer key/secret,
inbound sync into WeldCommerce products, orders, and people. Shopify custom apps
(Admin API token + API secret) are the second.

### Multi-store

A workspace can connect more than one store of the same type. Live uniqueness is
`(provider, external_account_id)` where `deleted_at` is null. Reconnecting the
same store URL reuses the row so mappings stay valid.

### Sales channels

The product row is the canonical catalogue item. `product_sales_channels` is the
sibling that records origin: provider, connection, external id, and listing URL.
The same SKU across two stores is one product with two channel rows. Deleting a
listing from one store marks that channel `deleted_remote` and only soft-deletes
the product when no active channels remain.

### Webhook-only updates (do not poll)

Tenant Neon databases autosuspend. Opening every workspace on a 10-minute or
30-minute cron would keep them awake. Ecommerce connectors therefore:

1. Run **one initial backfill** when the store is connected (`trigger: 'initial'`).
2. Register store webhooks on connect. Delivery URL:
   `https://integration-webhooks[-test].weldsuite.org/webhooks/connectors/:connectionId`.
3. After that, **only a store push** opens the tenant database:
   store → `integration-webhook-worker` (KV `connconn:` lookup, no tenant DB) →
   app-api `POST /api/integrations/connections/:id/connector-event` (HMAC + ingest).
4. **Sync now** remains a manual backfill. It is never scheduled.

Ecommerce providers are excluded from `integration-sync-worker` (`*/30`) and from
the webhook-worker poll cron (`*/10`). Those timers still exist for CRM OAuth
connections and Sheets/Gmail workflow polls; they must not grow a connector
sweep. Do not add `woocommerce` or `shopify` to `SYNCABLE_PROVIDERS`.

Local `wrangler` has no public HTTPS URL, so webhook registration is skipped with
a warning; connect still succeeds and Sync now covers import until the store can
reach WeldSuite.

## Consequences

- Nango routes, secrets (`NANGO_*`), and `@weldsuite/nango` are removed.
- `nango_connections` / `nango_sync_runs` are dropped; `connector_connections`
  / `connector_sync_runs` take their place. Imported rows still map through
  `integration_entity_mappings`.
- Adding a connector is a catalog entry, a provider client, mappers, webhook
  topics, and settings toggles — not a Nango integration plus a poller.
- Outbound sync (Weld → store) is still open.
