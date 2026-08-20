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
orders, customers, …). Sync is triggered from the UI (and later a schedule);
there is no third-party sync host in the path.

WooCommerce is the first connector: store URL + REST API consumer key/secret,
inbound sync into WeldCommerce products, orders, and people.

## Consequences

- Nango routes, secrets (`NANGO_*`), and `@weldsuite/nango` are removed.
- `nango_connections` / `nango_sync_runs` are dropped; `connector_connections`
  / `connector_sync_runs` take their place. Imported rows still map through
  `integration_entity_mappings`.
- Adding a connector is a catalog entry, a provider client, mappers, and
  settings toggles — not a Nango integration plus webhook.
- Outbound sync and provider webhooks are still open.
