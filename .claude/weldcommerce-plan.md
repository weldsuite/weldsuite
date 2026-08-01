# WeldCommerce — implementation plan

Status: Phase 1 in progress (product categories). Phases 2–5 unstarted.

**Phase 6 was pulled forward** (2026-08-01, by request): a deliberately thin
platform frontend now exists at `app/weldcommerce/` + `src/routes/weldcommerce/`,
covering products / categories / orders / customers with list + create + edit +
delete, and object panels for `product`, `category`, and `order`. It is built
against the *current* passthrough API, so it inherits every gap Phases 2–5 are
meant to close — no variant management, no order state machine, no stock
reservation, no discount evaluation, no category rule editor (the UI creates
manual categories only). Treat those phases as still owing; the UI will need
revisiting as each lands.

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

**Exists (platform), as of 2026-08-01:** `app/weldcommerce/` +
`src/routes/weldcommerce/` and `hooks/queries/use-commerce-queries.ts` — see the
Phase 6 note below. Thin by construction; the services underneath are still the
generated CRUD shell described above.

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

### Phase 6 — Platform frontend ← *pulled forward, thin version shipped*

Landed as `app/weldcommerce/` + `src/routes/weldcommerce/` (not `app/commerce/`
as originally sketched — the route matches the app code `weldcommerce`, which is
what the sidebar builds its link from). `useAppAccess('weldcommerce')` gate,
query hooks in `hooks/queries/use-commerce-queries.ts`.

> Pattern note, learned the hard way: **do not model a new module on WeldStash.**
> WeldStash was the least-developed module in the repo (in-page tab strip, hand-rolled
> `<Table>`, no module sidebar), and copying it produced a module that looked
> nothing like the rest of the platform. WeldCRM and WeldFlow are the reference:
> module sidebar + `EntityGrid` + grid config + object panel. WeldStash itself was
> refactored onto that pattern at the same time as this phase landed.

What shipped:
- Sections: overview, products, categories, orders, customers — reached from the
  **global module sidebar**, via `MODULE_CONFIGS.weldcommerce` in
  `components/layout/module-sidebar-configs.tsx`. The module layout is a thin
  wrapper like WeldCRM's; it renders no navigation of its own.
- Each list uses the **simple table** — the shared `EntityList`
  (`@weldsuite/weldmeet-ui`, re-exported from `components/entity-list`), which
  is what WeldBooks / WeldCall / WeldChat / WeldConnect use. *Not* `EntityGrid`:
  that's the spreadsheet-style surface with the inline column header (A/B/C
  letters, insert-left/right, hide, sort) used by WeldCRM, and it was
  explicitly not wanted here.
- Lists go through `components/panel-entity-list.tsx`, a thin wrapper over
  `EntityList` (the same move WeldBooks makes with `weldbooks-entity-list.tsx`):
  EntityList's built-in row renderer wraps every cell in `stopPropagation` so
  rows can't be clicked, and appends a hard-coded, non-i18n Edit/Duplicate/
  Delete menu. The wrapper supplies its own `renderRow` with a clickable row
  and a translated Edit/Delete menu.
- Columns live in `config/<entity>-columns.tsx` as `ColumnDef[]`.
- Object panels registered for `product`, `category`, `order`; customers and
  the order → customer drill-down reuse the existing `company` / `person` panels.

**A customer is a company OR a person.** The identity layer has two objects and
"Customer" / "Supplier" / "Lead" are status flags on the row, not object types.
So the customers list unions `/companies` and `/people` into a `CustomerRow`
carrying `kind` (`config/customer-row.ts`), and `kind` doubles as the
object-panel type. Create offers both; edit is fixed to the row's own kind,
since the two live in different tables.

Consequences of the simple table, worth knowing before extending it:
inline cell editing, per-user column show/hide + resize, row selection, bulk
delete and CSV/XLSX export are all `EntityGrid` features and are **not**
available here. Editing happens in the row menu's dialog or the object panel.
- `weldcommerce` added to `POST_REFACTOR_APPS` in `lib/apps/app-permission-objects.ts`
  as `['products', 'categories', 'orders', 'companies']` — without it the access
  guard treats the app as owner-only.

Landed alongside it (2026-08-01), each closing part of a later phase early:
- **Product ↔ category linking.** `category_products` is finally wired — attach
  from the category panel's Products tab, or from the product panel's
  Categories tab. Writes always go through the category-side endpoints
  (`POST|DELETE /categories/:id/products`) so the junction has one owner.
  New: `GET /products/:id/categories` (reverse read, uses the existing
  `category_products_product_idx`). Manual membership only — an automated
  category's members are computed from rules and never materialise as rows.
- **Nested categories in the UI.** The list is tree-ordered from
  `/categories/tree` (flattened depth-first, indented by `depth`) when no
  search is active, and falls back to the flat cursor-paged list while
  searching. The parent picker excludes the category's own subtree via a
  `path` prefix test, so the cycle the API rejects can't be selected.
- **Product images.** `products.images` (jsonb) and `featured_image_url` were
  already in the schema but absent from the form schema; both are now editable,
  with real uploads through `useFileUpload` (R2, `isPublic: true`). The first
  image is the featured one — `featuredImageUrl` is derived on save rather than
  entered separately.
- **`GET /orders/:id/items`** (see the Orders note above).

Known thinness, inherited from the API rather than the UI:
- Categories are creatable as `manual` only; the rule builder for `automated`
  categories is not built, so the dialog shows a hint instead.
- Order status is a free-form string chosen from a UI-side list — there is no
  server-side state machine yet (Phase 3).
- No variants, media, bulk ops, discounts, or checkout surfaces.

The original reasoning for deferring this phase still holds and is worth
re-reading before extending it: every phase above ships a stable API first, and
WeldStash already showed what a UI built against an unfinished API looks like.

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
