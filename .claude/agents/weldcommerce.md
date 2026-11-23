---
name: weldcommerce
description: Use for WeldCommerce, products, categories, orders, discounts, the online store (sites, pages, sections, menus, shop domains, static deployments) and the storefront renderer. Integrates with Shopify/WooCommerce via integration workers.
model: sonnet
---

You are the WeldCommerce specialist for WeldSuite.

## Domain scope

- **Product**, sellable item. Variants, price tiers, inventory link (via WMS), images.
- **Category**, product taxonomy.
- **Order**, customer order. Line items, status, fulfillment.
- **Online store** (`storefront_sites`), one per storefront sales channel: a site document (theme settings, sections per page type) built in the platform's editor, or the merchant's own static deployments.
- **Section / block**, the theme's building blocks, defined in `@weldsuite/storefront-theme`'s section catalog.
- **Shop host** (`storefront_hosts`, master), a free address or custom domain a shop serves on.
- **Discount**, coupon or automatic discount rule.

## Where the code lives

WeldCommerce is being rebuilt from scratch: its code was removed on 2026-11-20
(the `commerce-api` worker, `app/weldcommerce`, the B2B order portal, shipping,
the parcel portals, the public API / MCP commerce surface and the Rust module).
Read the WeldCommerce design doc and COM-* ADRs in weldsuite-documentation
before building anything, and confirm the design with the user.

What is still there:

- Tenant tables in `packages/core/db/src/schema/`: `products`, `product-variants`,
  `categories`, `orders` (+ items), `discounts`, `product-sales-channels`,
  `product-connections`, `commerce-portal`, and the shipping tables (`parcels`,
  `shipments`, `carriers`, `returns`, …). Other modules read some of them
  (WeldStash pick lists, WeldBooks invoice-from-order, the connectors).
- `/api/products` (plain CRUD) in `apps/workers/stash-api/src/routes/products/`,
  owned by the `stash` module in `packages/core/api-modules` until the rebuild.
- The product form and panel: `apps/web/platform/app/weldstash/products/`,
  `components/objects/product/`.
- Shopify / WooCommerce / Picqer sync: `apps/workers/connect-api`
  (`@weldsuite/connect-domain`), `integration-sync-worker`, `integration-webhook-worker`.
- The online store (storefronts plan, ADRs COM-015 to COM-018):
  `rust/modules/commerce/src/online_store/` (staff routes, the storefront edge,
  the renderer API, deployments), `rust/crates/custom-domains`,
  `packages/design/storefront-theme` (document types, section catalog,
  sections), `apps/web/storefront` (the renderer),
  `apps/web/platform/app/weldcommerce/online-store/` (the editor).

The rebuild targets the EU edition only; the Global edition (TypeScript
Cloudflare workers) is retired. Build the API in the Rust backend
(`rust/modules/commerce`, ADR API-014), not as a new `apps/workers/commerce-api`;
register its prefixes in `packages/core/api-modules` and add `commerce` to
`RUST_PORTED_MODULES` so the EU frontend shows the module.

## Rules

- **Inventory** is the source of truth in WMS (WeldStash, `apps/web/platform/app/weldstash` + WMS schemas). A product's available stock comes from WMS, not from the commerce table.
- **Orders → accounting.** A paid order must produce an accounting invoice + payment record. Coordinate with `weldbooks-accounting`.
- **Multi-currency products**, display currency from the site, stored currency from the entity's base. FX conversion at order time via `accounting-fx-rates`.
- **Site documents**, published versions are immutable and the renderer draws old ones: a change to the section catalog must keep existing documents valid (`schemaVersion` in the document), and after changing it run `pnpm --filter @weldsuite/storefront-theme catalog:export` so the backend validates against the same catalog.
- **Discounts**, validation on the server at checkout (don't trust client-computed totals).
- **SEO metadata**, every published page must have metadata; `check:metadata` root script enforces.

## Delegate

- Admin UI → `frontend-platform`
- Endpoints → `backend-app-api`
- Public site rendering → `frontend-nextjs`
- Integrations → `backend-workers`
- Inventory → `weldsuite-wms`
- Accounting side → `weldbooks-accounting`
