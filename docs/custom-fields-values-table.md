# Custom fields: typed values table (design)

Status: **in progress**, Phases 0 (schema + service + validation) and 1
(dual-write) are live in production. Phase 2 backfill script is written but not
yet run; Phase 3 (read cutover + sort/filter) is next.

## Problem

Custom field **definitions** live cleanly in `custom_field_definitions` (tenant DB):
org-wide reusable columns keyed to a platform `entityType`, with 15 field types,
`options`, and `config`.

Custom field **values**, however, are stored in a `custom_fields jsonb` blob, a
`Record<slug, value>`, on **16 entity tables**:

`companies`, `people`, `tasks`, `products`, `product-variants`,
`crm-opportunities`, `crm-activities`, `helpdesk-tickets`,
`helpdesk-conversations`, `helpdesk-articles`, `mail-messages`, `mail-accounts`,
`calendar-events`, `discounts`, `categories`, `parcels`.

Because values sit in an opaque blob:

- **No SQL sort / filter / index / aggregate** on values. The grid hard-codes
  `sortable: false` (`apps/web/platform/components/custom-fields/to-grid-columns.ts`).
- **No type enforcement**, everything is `unknown`.
- **No referential integrity** for `user_ref` / `entity_ref` fields.
- Values are keyed by **slug**, so renaming a field orphans its data.

## Target architecture, one typed EAV values table

`custom_field_values` (tenant DB): one row per (entity, field). Each value gets
its own real, indexable cell.

| column        | type             | holds                                             |
| ------------- | ---------------- | ------------------------------------------------- |
| `id`          | varchar(30) pk   | `generateId('cfv')`                               |
| `created_at`  | timestamp        |                                                   |
| `updated_at`  | timestamp        |                                                   |
| `field_id`    | varchar(30)      | → `custom_field_definitions.id` (**stable** key)  |
| `entity_type` | varchar(50)      | denormalized from the definition                  |
| `entity_id`   | varchar(30)      | `companies.id` / `people.id` / ...                |
| `value_text`  | text             | text, textarea, url, email, phone, single_select  |
| `value_number`| double precision | number, currency, rating                          |
| `value_date`  | timestamp        | date                                              |
| `value_bool`  | boolean          | boolean                                           |
| `value_json`  | jsonb            | multi_select (`string[]`), file metadata          |
| `value_ref`   | varchar(30)      | user_ref / entity_ref (referenced id)             |

The value lives in exactly one typed column, decided by the definition's
`fieldType`; the rest stay null.

Indexes:

- `unique(entity_type, entity_id, field_id)`, one value per field per entity.
- `(entity_type, entity_id)`, fetch all values for a row.
- `(field_id, value_text)`, `(field_id, value_number)`, `(field_id, value_date)`,
  `(field_id, value_bool)`, `(field_id, value_ref)`, power sort/filter on a field.

No `workspaceId`, tenant DBs are per-workspace (matches
`custom_field_definitions`). Keying on `field_id` makes field renames safe.

## Components

1. **Schema**, `packages/core/db/src/schema/custom-field-values.ts` (exported
   from the schema barrel). ✅ Phase 0.
2. **Shared validation**, `packages/clients/app-api-client/src/schemas/custom-fields.ts`:
   `setCustomFieldValuesSchema`, `fieldTypeToValueColumn()`, and
   `validateCustomFieldValue()` (per-`fieldType` coerce + option checks). ✅ Phase 0.
3. **Service**, `apps/workers/app-api/src/services/custom-field-values.ts`:
   `getValuesForEntities` (batch, avoids N+1), `getValuesForEntity`, `setValues`
   (validated upsert; `null` clears), `deleteValuesForEntity`,
   `getDefinitionsForEntityType`. Exposed as a `{ [slug]: value }` map so the
   entity APIs keep their current shape. ✅ Phase 0.
4. **Entity wiring**, each of the 16 entity services calls `setValues` on
   create/update, hydrates `customFields` from the values table on get/list, and
   `deleteValuesForEntity` on delete.
5. **Sort/filter**, list query builders accept `sort=custom:<slug>` and
   `filter[custom:<slug>]=…`, translated to an indexed JOIN/LATERAL on
   `custom_field_values`. Frontend flips columns to `sortable: true` and wires
   filter descriptors.

## Rollout

- **Phase 0**, schema + service + validation. No behavior change. ✅
- **Phase 1**, dual-write: write values table **and** the jsonb blob; reads
  still from the blob. ✅ `syncValuesForEntity` (best-effort mirror, never fails
  the primary write) is wired into every surface whose **API accepts
  `customFields`**: `companies` + `people` (services, incl. the
  `importCompanies` / `importPeople` create/update paths), and the `tasks`,
  `opportunities`, `activities`, `tickets` routes (create + update).
- **Phase 2**, backfill all tenant DBs (one-off script in
  `apps/tools/migrate-databases`, exploding each blob into typed rows); verify
  parity. ✅ Script landed:
  `apps/tools/migrate-databases/src/backfill-custom-field-values.ts`
  (`pnpm backfill:cfv` dry-run / `pnpm backfill:cfv:execute`).
  **TEST environment only so far** (2026-07-20): all 20 test tenants swept,
  67 rows inserted, parity OK, re-run confirmed idempotent.
  **Production has NOT been backfilled**, use the `Backfill Custom Field
  Values` GitHub workflow, see "Running the backfill" below.
- **Phase 3**, switch reads to the values table; enable sort/filter and
  sortable grid columns. ⚠️ **Backend done, frontend blocked.**
  - ✅ Read cutover wired for all 6 entity types via `hydrateCustomFields` /
    `hydrateCustomFieldsOne` (batched: 2 extra queries per page, any page size).
    Includes a **migration-window blob fallback**, an entity with zero value
    rows keeps serving its blob, so this is safe to deploy into an environment
    that has not been backfilled yet. Remove the fallback at Phase 4.
  - ✅ Sort/filter SQL in `apps/workers/app-api/src/services/custom-field-query.ts`,
    wired into `listCompanies` + `exportCompanies` via `sort=custom:<slug>`,
    `sortDir`, and `customFilter=<slug>:<value>`. Verified against a live tenant.
  - ⚠️ **Custom-field sort uses OFFSET paging.** The default keyset cursor is
    keyed on `(createdAt, id)`, which stops describing row order under a custom
    sort. Only the custom-sort path falls back to OFFSET; the default path keeps
    its keyset. `cursor` carries the numeric offset in that mode, so the
    response envelope is unchanged. Upgrade to a composite keyset cursor if deep
    pagination ever matters.
  - ❌ **Frontend not done, and not a one-line flip.** `sortable` exists in
    `components/entity-grid/types.ts` but has **no implementation anywhere in
    `entity-grid/`**, no sort UI, no handler, no query wiring. Flipping custom
    columns to `sortable: true` today would be a dead flag. Making custom fields
    sortable in the UI first requires building sort support into the entity grid,
    which is a general grid feature, not custom-fields work.
  - Only `listCompanies` has the sort/filter params so far; the other five
    entity types need the same treatment once the grid can express it.
- **Phase 4**, stop writing the blob; drop the 16 `custom_fields` columns
  (separate migration). Migration is **written but deliberately NOT wired into
  drizzle**: `apps/tools/migrate-databases/src/migrations/phase4-drop-custom-fields-columns.sql`
  (no journal entry, so the migrator cannot pick it up). It documents five
  preconditions, read them before moving it.

## Running the backfill (Phase 2)

Prerequisite: Phase 1 dual-write must already be live in the target environment.
Backfilling first would leave a gap, writes between the backfill and the deploy
would land only in the blob.

### Production (and any non-local environment), use the workflow

Run the **`Backfill Custom Field Values`** GitHub Action
(`.github/workflows/backfill-custom-field-values.yml`) via *Run workflow*:

| input         | notes                                                       |
| ------------- | ----------------------------------------------------------- |
| `environment` | `test` / `preview` / `production`, selects the GH Environment whose secrets are used |
| `dry-run`     | **defaults to true**; untick only after reading the report   |
| `workspace`   | optional `ws_…` for a single tenant                          |
| `entity-type` | optional single custom-field entity type                     |
| `verbose`     | per-table detail + orphan/invalid samples                    |

Credentials come from the selected GitHub Environment, exactly as
`migrate-database.yml` already does for tenant migrations, a production
connection string never needs to land in a local `.env`.

Always run `dry-run` first, read `orphan` / `invalid` / `missingTable`, then
re-run with `dry-run` unticked.

### Local (test environment)

`apps/tools/migrate-databases/.env` supplies `MASTER_DATABASE_URL`, whichever
environment that points at is the one that gets swept, so check it before
running.

```bash
cd apps/tools/migrate-databases
pnpm backfill:cfv                          # dry-run report across all tenants
pnpm backfill:cfv -- --verbose             # + per-table detail, orphan/invalid samples
pnpm backfill:cfv -- --only ws_abc123      # single workspace
pnpm backfill:cfv -- --entity-type company # single entity type
pnpm backfill:cfv:execute                  # write
```

Design properties that make it safe to re-run and safe to interrupt:

- **Insert-only.** `ON CONFLICT (entity_type, entity_id, field_id) DO NOTHING`,
  so an existing row, written by the Phase 1 mirror, or by a previous run,   is never overwritten. The fresher dual-write value always wins.
- **Read-only against the blob.** Nothing is deleted or rewritten in the source
  `custom_fields` columns, so a value the sweep skips is not a value lost; it
  stays in the blob until Phase 4.
- **Same coercion as the live path.** Values go through the shared
  `validateCustomFieldValue` / `fieldTypeToValueColumn` from
  `@weldsuite/app-api-client/schemas/custom-fields`, so a backfilled row is
  identical to what a live write would have produced. This is what makes the
  parity number meaningful rather than self-confirming.
- **Missing-table tenants are reported, not fatal.** Tenant migrations can fail
  partway; a tenant without `custom_field_values` is flagged
  (`custom_field_values MISSING`) and skipped, and the run exits non-zero.
- **Soft-deleted parents are included.** Their blob is still restorable data;
  skipping it would silently lose it at Phase 4.
- **Required is not enforced.** A historical row predating a field being made
  required still migrates, matching the mirror's `enforceRequired: false`.

Two categories are deliberately **not** migrated, and both are reported with
samples under `--verbose`:

- **Orphaned slugs**, a blob key with no active `custom_field_definitions` row
  (renamed field, or a definition that was soft-deleted). Cannot be mapped to a
  stable `field_id`, so there is nothing to key the value row on.
- **Invalid values**, fail type coercion (e.g. `"abc"` in a `number` field, an
  option value no longer in the definition's `options`).

Both remain in the blob. **Review the orphan/invalid report before Phase 4**,
since dropping the `custom_fields` columns is what actually discards them.

Exit code is 0 only when no tenant failed and none were missing the table;
parity (`migratable == alreadyPresent + inserted`) is reported per tenant and in
the total.

### Coverage caveat (as of 2026-07-20)

Every custom field definition that exists in production today is `fieldType:
'text'`, and only the `company` entity type has any definitions at all. So the
first live run exercised exactly one path: `value_text` on `companies`.

Not yet exercised against a real database:

- The `::double precision` / `::timestamp` / `::boolean` / `::jsonb` casts in
  the batch INSERT, which only bind non-null on number / date / boolean /
  multi_select+file fields. The coercion feeding them is unit-checked against
  the shared `validateCustomFieldValue`, but the SQL casts themselves have never
  run with a non-null value.
- The read query against `people`, `tasks`, `crm_opportunities`,
  `crm_activities`, `helpdesk_tickets`, all short-circuit at "no definitions".

Neither is a reason to hold Phase 2, but both are worth re-checking the first
time a non-text field or a non-company entity type gains real data.

## Gated on approval (per CLAUDE.md)

- ✅ Drizzle migration for `custom_field_values`,   `drizzle/tenant-migrations/0168_lumpy_earthquake.sql` (create table + indexes
  only; no other tables touched). Applied to tenants via the normal
  `migrate-databases` runner / deploy pipeline. The workspace-worker migration
  bundle is a deploy-time build artifact (`pnpm bundle-migrations`) and is not
  committed per migration.
- The Phase 2 backfill script writes only to `custom_field_values` (inserts, no
  schema change). It has not been run against production, do that dry-run-first.
- Dropping the 16 `custom_fields` jsonb columns (Phase 4), a second, separate
  migration.

## Custom-field `entityType`, canonical strings

The mirror is keyed by the same `entityType` string the definitions UI uses
(bare singular logical name, e.g. the `CustomFieldsSidebarSection`
`entityType="company"` prop). Any future custom-field surface for these entities
MUST use the same string:

| table              | custom-field `entityType` | wired          |
| ------------------ | ------------------------- | -------------- |
| companies          | `company`                 | ✅ (+ import)  |
| people             | `person`                  | ✅ (+ import)  |
| tasks              | `task`                    | ✅             |
| crm_opportunities  | `opportunity`             | ✅             |
| crm_activities     | `activity`                | ✅             |
| helpdesk_tickets   | `ticket`                  | ✅             |

Note: the custom-field `entityType` is its own namespace and does **not** always
equal the entity-events `entityType` (e.g. tasks emit events as `project_task`
but their custom fields use `task`; companies emit `customer`/`company` events
but custom fields use `company`).

### Intentionally NOT wired (yet)

The other 10 tables carrying a `custom_fields` jsonb column, `products`, `product_variants`, `mail_messages`, `mail_accounts`,
`helpdesk_articles`, `helpdesk_conversations`, `calendar_events`, `discounts`,
`categories`, `parcels`, do **not** accept `customFields` on their create/update
API today (no field in their Zod schemas), so there is nothing to mirror; wiring
them now would be dead code. Each gets a one-line `syncValuesForEntity(...)` when
its API/surface starts accepting custom fields. (The helpdesk `DynamicTicketForm`
uses ticket-**type** fields, a separate mechanism, not `custom_field_definitions`.)

## Notes / decisions

- Field **rename-safe** (keyed by `field_id`).
- Soft-deleting a definition leaves its value rows inert (recoverable) rather
  than cascading a delete.
- `user_ref` / `entity_ref` → `value_ref`; existence validation optional/future.
- Permissions unchanged: values inherit the parent entity's permission;
  definitions stay `settings:*`.
