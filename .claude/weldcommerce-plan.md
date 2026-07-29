# WeldCommerce — implementation plan

Status: Phase 1 in progress (product categories). Everything below Phase 1 is
unstarted.

## Where we actually are

WeldCommerce is a module name with a database behind it and almost nothing else.

**Exists (tenant DB):** `products`, `product_variants`, `categories` +
`category_products`, `orders` + order items, `discounts`, `product_connections`,
plus the shipping/parcel side (`carriers`, `shipments`, `returns`, `boxes`,
`parcels`).

**Exists (app-api):** `/api/products`, `/api/categories`, `/api/orders`,
`/api/discounts` — all of them the same generated 5-endpoint CRUD shell
(list / get / create / patch / soft-delete). No business logic, no relations
wired, no derived fields maintained.

**Does not exist:** any WeldCommerce frontend in `apps/web/platform`. No
`app/commerce/`, no `src/routes/commerce/`. No query hooks reference any
commerce endpoint. `category_products` is migrated but referenced by zero lines
of application code.

So the work is not "build a data model" — it is "make the existing tables behave
like a commerce system, then put a UI on them".

## Out of scope

- **The website/storefront builder.** Deferred by decision; there is no
  `_builder/` or `_preview/` route group in the platform today (CLAUDE.md still
  lists them — that reference is stale).
- **The public storefront renderer** (`apps/web/sites`) stays as-is.

## Phasing

Each phase is backend-first, matching how WeldStash was built: schema → service
→ routes → shared Zod → (later) hooks and UI. Phases are ordered so each one is
useful on its own and nothing later has to rewrite what came before.

### Phase 1 — Product categories & collections ← *doing now*

Merchandising groupings, modelled on Shopify. Detail below.

### Phase 2 — Product catalogue depth

The `products` table is broad but the route is a passthrough.

- Variant management as a real sub-resource (`/products/:id/variants`), option
  matrix generation, per-variant SKU/barcode uniqueness.
- Media ordering, alt text, featured-image derivation.
- Slug uniqueness and collision handling (currently unchecked, same bug as
  categories had).
- Publish state and scheduled publishing.
- Bulk operations — the thing that makes a catalogue tool usable at all.
- `product_connections` (related / upsell / cross-sell) finally wired.

### Phase 3 — Orders & fulfilment

- Draft → placed → fulfilled → cancelled state machine, with the transitions
  guarded server-side rather than by whatever the client sends.
- **Stock reservation on order placement.** This is the hook the inventory
  ledger was built for: `applyStockChange` already exists, and
  `inventory.quantity_allocated` is still permanently zero because nothing
  reserves. Placing an order reserves; cancelling releases; fulfilling converts
  the reservation into an issue.
- Order numbering (there is a `task-numbering` service to model it on).
- Partial fulfilment and partial refunds.
- Returns tied back to stock (`returns` + `return_reasons` exist, unwired).

### Phase 4 — Pricing, discounts & tax

- Discount evaluation engine (the `discounts` table has no evaluator).
- Price lists / customer-group pricing.
- Tax via the existing `accounting-tax-rates` rather than a second tax model.

### Phase 5 — Checkout & payments

- Cart persistence, checkout sessions, Stripe via `billing-worker`.
- Abandoned-cart events through `@weldsuite/entity-events`.

### Phase 6 — Platform frontend

`app/commerce/` + `src/routes/commerce/`, following the WeldStash layout
(module layout with tabs, `useAppAccess('weldcommerce')` gate, query hooks in
`hooks/queries/use-commerce-queries.ts`). Deliberately last: every phase above
ships a stable API first, and WeldStash has already shown what a UI built
against an unfinished API looks like.

---

## Phase 1 detail — categories & collections

### The modelling decision

Shopify has two distinct concepts:

- **Collections** — flat, not nested. Either *manual* (you pick the products) or
  *smart/automated* (rules like `vendor equals Acme`). Carries a sort order.
- **Product category** — a single value from Shopify's standard taxonomy, used
  for tax and shipping inference.

The repo's `categories` table is already hierarchical (`parentId`, `path`,
`depth`) — which Shopify collections are not. Rather than add a second
`collections` table and make every consumer ask "is this thing a category or a
collection?", Phase 1 **folds the collection semantics into `categories`**: a
category is manual by default and becomes automated when you give it rules.

The trade-off, stated plainly: this is not API-compatible with Shopify's
`/collections` endpoint, so the Shopify integration in `integration-sync-worker`
will need a mapping layer when it lands. In exchange there is one tree, one
permission object, one set of endpoints, and hierarchy comes free — which flat
Shopify collections never got.

Shopify's *taxonomy* category is a separate concern and is not Phase 1.

### Schema additions to `categories`

| Column | Purpose |
|---|---|
| `type` | `manual` \| `automated` |
| `rules` | jsonb `[{ column, relation, condition }]` |
| `rulesMatch` | `all` \| `any` (Shopify's `disjunctive`) |
| `sortOrder` | how members are ordered |
| `publishedAt` | scheduled/actual publication |

`category_products` stays as the manual membership table and gains a unique
index on `(category_id, product_id)`.

### Rule grammar

Columns map to a server-side whitelist — a rule never reaches SQL as an
identifier, only as a bound value.

`name`, `productType`, `vendor`, `brand`, `sku`, `status`, `tag`, `price`,
`compareAtPrice`, `weight`, `inventoryQuantity`

Relations: `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`,
`ends_with`, `greater_than`, `less_than`.

### Endpoints

- `GET /api/categories/tree` — the hierarchy in one call
- `GET /api/categories/:id/products` — resolved members (junction for manual,
  live rule query for automated), honouring `sortOrder`
- `POST /api/categories/:id/products` — attach (manual only)
- `DELETE /api/categories/:id/products/:productId` — detach (manual only)
- `POST /api/categories/preview-members` — evaluate rules before saving
- existing CRUD, hardened: slug uniqueness, `path`/`depth` maintenance,
  parent-cycle rejection, delete guarded against orphaning children

### What Phase 1 deliberately does not do

- No `productCount` denormalisation. It would be wrong the moment an automated
  category's rules match a newly-created product, and the inventory work already
  showed that a derived count is only safe when something recomputes it. Counts
  come from the list endpoint's `totalCount`.
- No Shopify standard taxonomy import.
- No frontend.
