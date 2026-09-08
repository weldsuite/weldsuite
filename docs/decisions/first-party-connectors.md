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

WooCommerce is the first connector. Merchants enter **only the store URL** and
click Connect. We send them to WooCommerce's Application Authentication Endpoint
(`{store}/wc-auth/v1/authorize`, scope `read_write`). After they grant access,
the shop POSTs `{ consumer_key, consumer_secret }` to **app-api**
(`POST https://app-api[-test].weldsuite.org/webhooks/woocommerce/auth`). The
callback must return **HTTP 200** immediately after storing the keys — WooCommerce
deletes them and shows “unable to send the consumer data” on any other status.
Do not call the shop (credential test, webhook registration) until after that
200 (`waitUntil`). `user_id` is a signed token (`wooa.<payload>.<mac>`), not KV,
so the callback does not depend on eventually-consistent KV or a second worker.
The browser return never carries secrets. This is **not OAuth 2.0**. Pasting keys
generated under WooCommerce → Settings → Advanced → REST API still works as a
fallback on `POST /connectors/connect`.

Shopify custom apps (Admin API token + API secret) are the second connector.

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

### Hybrid updates (webhooks + D1 catch-up)

Tenant Neon databases autosuspend. Opening every workspace on a timer would keep
them awake. Ecommerce / accounting connectors therefore use **hybrid** delivery:

1. Run **one initial backfill** when the store is connected (`trigger: 'initial'`).
2. Register store webhooks on connect. Delivery URL:
   `https://integration-webhooks[-test].weldsuite.org/webhooks/connectors/:connectionId`.
3. Live path: store push → `integration-webhook-worker` (KV `connconn:` lookup,
   no tenant DB) → app-api `POST /api/integrations/connections/:id/connector-event`
   (HMAC + ingest).
4. Catch-up path: `integration-sync-worker` (`*/15`) reads due rows from D1
   `connector_sync_index`, decrypts the credential copy, probes the store
   (`hasUpdatesSince` / reconcile fingerprint), and **only then** calls app-api
   to open the tenant. A no-op tick never touches master or tenant Neon.
5. **Sync now** remains a manual backfill (and resumes truncated catalogues via
   page cursors in `sync_watermarks`).

Do **not** add `woocommerce` / `shopify` / `moneybird` to CRM
`SYNCABLE_PROVIDERS`. CRM OAuth connections use a separate D1 `crm_sync_index`
with the same wake-avoidance rule. Outbound catalogue publish (sales channels)
is supported; full bidirectional order/customer push is still open.

Local `wrangler` has no public HTTPS URL. WooCommerce **refuses a non-HTTPS
callback**, so `POST /connectors/authorize` returns 400 until this worker is
reached over HTTPS (`APP_API_PUBLIC_URL`, or the authorize request's own
`https://` origin). Store-push webhook registration is separate and still uses
`CONNECTOR_WEBHOOK_BASE_URL` / the `integration-webhooks` host; it is skipped
with a warning when the delivery URL is `http://`.

## Consequences

- Nango routes, secrets (`NANGO_*`), and `@weldsuite/nango` are removed.
- `nango_connections` / `nango_sync_runs` are dropped; `connector_connections`
  / `connector_sync_runs` take their place. Imported rows still map through
  `integration_entity_mappings`.
- Adding a connector is a catalog entry, a provider client, mappers, webhook
  topics, and settings toggles — not a Nango integration plus a poller.
- Outbound catalogue publish via sales channels is supported for ecommerce
  connectors; Picqer adds bidirectional WMS push via
  `/api/connectors/connections/:id/picqer/push` and product write clients.

## Picqer (first `wms` connector)

Picqer is a hybrid first-party connector (`category: wms`) with API-key auth
(subdomain + API key). It syncs every overlapping WeldStash / WeldCommerce
object: products, customers, orders, inventory, warehouses, locations,
pick lists, shipments, suppliers, purchase orders, returns, stock counts, and
movements.

### Delivery

- Live: Picqer hooks → `integration-webhook-worker` (forwards
  `X-Picqer-Signature`) → app-api `connector-event`.
- Catch-up: D1 `connector_sync_index` probe as for other hybrid connectors.
- Signature: HMAC-SHA256 of the raw body, Base64 (`X-Picqer-Signature`).
- Payload envelope: `{ event, data }` — topic from `event`, record from `data`.

### Bidirectional / echo rules

- Connection default direction is `bidirectional`; per-object overrides use
  `objectSyncDirections`.
- Inbound skips when `integration_entity_mappings.syncChecksum` matches.
- Outbound push skips when the outbound payload checksum matches the mapping;
  successful pushes stamp `lastSyncedAt` / checksum before any follow-up event
  can re-queue the same payload.
- Catalogue identity fields (SKU / name / barcode) are bidirectional; stock
  quantities are inbound-primary from Picqer unless the object direction is
  outbound. Fulfillment status follows Picqer picklist / shipment events.
