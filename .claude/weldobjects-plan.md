# WeldObjects — user-defined custom objects

Status: **all phases implemented.** One thing is deliberately outstanding — the
tenant migration (see "Remaining work" at the bottom). This document is the
design record; the phasing section at the end records what shipped where.

Espo-style custom objects: a workspace admin defines an object type ("Machine",
"Certification", "Service Visit"), gives it fields and relationships, and gets a
real module — list, detail, forms, permissions, workflows, search, AI tools —
without a single migration or deploy.

## Where we actually are

More of this exists than you'd expect. The custom-**fields** half is done and
was built well; the custom-**objects** half is missing entirely.

**Exists and is directly reusable:**

- `custom_field_definitions` — field metadata keyed by an `entityType`
  **string** (`varchar(50)`), not an enum. Storage is already open-ended.
- `custom_field_values` — a genuine typed EAV store: one row per value, six
  typed columns (`value_text/number/date/bool/json/ref`), per-type composite
  indexes, unique on `(entity_type, entity_id, field_id)`. Keyed by the
  immutable field id, so renames never orphan data.
- [custom-field-query.ts](apps/workers/app-api/src/services/custom-field-query.ts)
  — indexed `ORDER BY` and `WHERE` fragment builders for custom fields, with the
  `custom:<slug>` key convention already established for grid sort/filter.
- `@weldsuite/db/lib/custom-field-values` — runtime-agnostic read/write/hydrate
  helpers, already shared by four workers.
- `components/entity-grid/` — the generic data grid.
- `components/custom-fields/to-grid-columns.ts` — field definitions → grid
  columns. Already written.
- `components/custom-fields/custom-fields-sidebar-section.tsx` — renders a
  field-definition-driven form/panel.
- `settings/custom-fields/field-definition-dialog.tsx` — the field editor.
- `search_index` — deliberately generic (`entity_type` + `entity_id`,
  registry-driven). Its own header says adding a searchable entity should be "a
  registry entry in the search service, not a fresh migration".
- `grid_views` — per-user column config keyed by a free-form `gridName` string.

**Does not exist:** any notion of a user-defined object type. No table for one,
no record table, no relationships, no routes, no UI, no sidebar entry.

So the work is not "build an EAV engine" — that shipped. The work is **"give the
`entityType` string a first-class definition behind it, and teach four
compile-time registries to accept runtime entries."**

## The core design decision

A custom object gets an **entity key** of the form `co_<slug>`. That single
string is the join key across every subsystem:

| Subsystem | Column / field | Value |
|---|---|---|
| `custom_field_definitions` | `entity_type` varchar(50) | `co_machine` |
| `custom_field_values` | `entity_type` varchar(50) | `co_machine` |
| `search_index` | `entity_type` **varchar(30)** | `co_machine` |
| entity events | wire `entityType` | `co_machine` → `co_machine:created` |
| `grid_views` | `grid_name` varchar(100) | `co_machine` |
| permissions | key segment | `weldobjects:machine:read` |

**`search_index.entity_type` is `varchar(30)`** — that is the binding
constraint. `co_` + slug means **slug is capped at 27 characters**; cap it at 24
for headroom. Enforce in the Zod schema, not just the column.

The slug is **immutable after creation**, matching how `custom_field_definitions.entityType`
is already immutable on update. Labels are freely renameable; the key is not.

### Why EAV and not JSONB or real tables

Confirmed decision. Records store their field values in the existing
`custom_field_values` table — no new value storage at all. This means indexed
sort and filter on custom object fields work on day one via the already-written
`customFieldOrderBy` / `customFieldFilter` fragments, and the entire field
editor UI is reused verbatim by pointing it at `entityType=co_<slug>`.

The cost is that reading a record means a pivot query against
`custom_field_values`. That is already solved by `hydrateCustomFields` /
`getValuesForEntities`, which batch-load values for a page of parent rows — the
same path companies and people already take.

One mitigation is designed in from the start: `custom_object_records.title`
denormalizes the record's display-name field value, so lists, pickers, related
panels, search results and workflow payloads can render a label without
touching the EAV table at all. It is maintained on write.

## Data model

Five new tenant-DB tables. Nothing in the master DB — custom objects are
per-workspace by definition.

### `custom_objects` — the object type

```
id                varchar(30) pk            cobj_...
slug              varchar(24) unique        'machine' — immutable, ^[a-z][a-z0-9_]*$
entityKey         varchar(30) unique        'co_machine' — derived, stored for joins
labelSingular     varchar(100)              'Machine'
labelPlural       varchar(100)              'Machines'
description       varchar(500)
icon              varchar(50)               lucide icon name
color             varchar(20)
titleFieldId      varchar(30)               which custom field is the record's display name
status            varchar(20)               'draft' | 'active' | 'disabled'
enableSearch      boolean default false
enableEvents      boolean default true
enableAgentTools  boolean default false
enableExternalApi boolean default false
listConfig        jsonb                     default visible columns + order
sortOrder         integer
createdAt/updatedAt/deletedAt
```

The four `enable*` flags matter more than they look. You asked for all four
integration surfaces, and per-object opt-out is what keeps that from becoming a
liability: a tenant with 30 objects should not get 150 MCP tools and 30 search
indexes by default. `enableEvents` defaults on (cheap, fire-and-forget);
the other three default off and are opt-in per object.

### `custom_object_records` — the record

```
id           varchar(30) pk       cor_...
objectId     varchar(30)          → custom_objects.id
entityKey    varchar(30)          denormalized; every list query filters on it
title        text                 denormalized display name (see above)
ownerId      varchar(255)         powers weldobjects:<slug>:scope:all
createdBy    varchar(255)
updatedBy    varchar(255)
createdAt/updatedAt/deletedAt

idx (entityKey, deletedAt)
idx (entityKey, ownerId)
idx (entityKey, title)
idx (objectId, createdAt)
```

Field values live in `custom_field_values` with
`entity_type = entityKey, entity_id = record.id`. No new value table.

### `custom_object_links` — relationship definitions

```
id                varchar(30) pk       colk_...
slug              varchar(50)          'service_visits'
sourceEntityKey   varchar(30)          always a custom object
targetEntityKey   varchar(30)          custom object OR built-in ('company','person',…)
cardinality       varchar(20)          'one_to_one'|'one_to_many'|'many_to_one'|'many_to_many'
sourceLabel       varchar(100)         panel heading shown on the TARGET's page
targetLabel       varchar(100)         panel heading shown on the SOURCE's page
onDelete          varchar(20)          'restrict' | 'cascade' | 'set_null'
required          boolean
sortOrder, createdAt/updatedAt/deletedAt

unique (sourceEntityKey, slug)
```

`targetEntityKey` accepting built-in entity types is what makes this useful —
"Machines belonging to this Customer" is the motivating case, not
custom-to-custom.

### `custom_object_relations` — relationship edges

```
id                varchar(30) pk       corl_...
linkId            varchar(30)          → custom_object_links.id
sourceEntityKey   varchar(30)
sourceId          varchar(30)
targetEntityKey   varchar(30)
targetId          varchar(30)
sortOrder         integer
createdAt, createdBy

unique (linkId, sourceId, targetId)
idx (linkId, sourceId)
idx (linkId, targetId)
idx (targetEntityKey, targetId)     ← the reverse-lookup index
```

One edge table serves all four cardinalities. The `(targetEntityKey, targetId)`
index is the one that powers "show every custom-object record linked to this
Customer" on a built-in detail page without knowing which links exist.

To-one cardinality (`one_to_one`, `many_to_one`) is **enforced in the service
layer inside a transaction**, not by a unique index — cardinality lives on the
link row, so no single partial index can express it. Write it once in
`services/custom-object-links.ts` and never inline the insert anywhere else.

### `custom_object_layouts` (Phase 2+, optional)

Field grouping and ordering for the detail view. Deferred; until it exists the
detail page renders `custom_field_definitions.group` + `sortOrder`, which is
already stored and already respected by the existing field components.

### Decision: links supersede `entity_ref` for custom objects

The existing `entity_ref` field type stores one id in
`custom_field_values.value_ref`. It has no reverse index by target type and no
many-to-many. For custom objects, relationships go through
`custom_object_links` — do not offer `entity_ref` in the custom-object field
editor, or you ship two mechanisms for one concept. `entity_ref` stays exactly
as-is for custom fields on built-in entities.

## The registry bridge

Four registries are compile-time closed. All four need the same treatment:
**keep the static catalog as the typed source of truth for first-party code,
add a merge function that unions in tenant-defined entries as plain strings.**

### 1. Entity events — `packages/core/entity-events`

`publishEntityEvent` types `entityType` against `ENTITY_EVENTS`, so `co_machine`
won't compile. Do **not** solve this by adding one `custom_object_record`
catalog entry with the slug in the payload — `triggerMatchesEvent` in
[workflow-dispatch.ts](packages/core/entity-events/src/workflow-dispatch.ts)
does strict `tEntityType !== entityType` equality, so every custom object would
share one trigger and workflows could not target a single object.

Instead add one narrow escape hatch:

```ts
// packages/core/entity-events/src/custom-objects.ts
export function publishCustomObjectEvent(params: {
  c: Context<…>;
  entityKey: string;        // 'co_machine' — validated against custom_objects
  action: 'created' | 'updated' | 'deleted';
  entityId: string;
  data: Record<string, unknown>;
  changes?: …;
}) { /* single documented cast to EntityType, then delegate */ }
```

The wire format stays `co_machine:created`, so the audit queue, analytics queue,
realtime DO, webhook delivery and workflow dispatch all work **unmodified**.
One cast, one file, one runtime existence check.

`parseEventName` / `isValidSubscription` / `isKnownEntityType` gain an optional
`extraEntityTypes?: ReadonlySet<string>` parameter. Only the workflow-trigger
and agent-subscription **validation** call sites pass it (loaded from
`custom_objects`); everything else keeps today's behaviour. `isKnownEntityType`
currently has exactly one caller, so this is a small change.

### 2. Permissions — `packages/core/permissions`

Good news: `permissionMatches` in
[engine.ts](packages/core/permissions/src/engine.ts) is segment-count agnostic
and wildcard-aware, so `weldobjects:machine:read` matches against a stored
`weldobjects:*` or `weldobjects:machine:*` **with zero changes**. Runtime
enforcement works today.

Only the role editor needs work. `GET /api/roles/permission-catalog` (in
[roles/index.ts](apps/workers/app-api/src/routes/roles/index.ts), which already
imports `PERMISSION_CATALOG_OBJECTS`) merges tenant custom objects into its
response as an additional object group.

Key shape:

- `weldobjects:manage` — define/edit/delete object types (a settings-level grant)
- `weldobjects:read` — see the module at all
- `weldobjects:<slug>:read|create|update|delete`
- `weldobjects:<slug>:scope:all` — cross-owner visibility, mirroring the
  `objectPermissions(..., { scopeAll: true })` pattern already used for leads

Render custom objects in their own collapsible group in the role editor. Five
keys × N objects gets visually unmanageable fast otherwise.

### 3. Search — `search_index` + `SEARCH_ENTITY_TYPES`

The table is already generic and registry-driven. The registry in
`@weldsuite/app-api-client/schemas/search` becomes static ∪ dynamic, and the
indexer needs a text-projection for custom objects: `title` plus the
concatenated text-ish field values (`text`, `textarea`, `url`, `email`, `phone`,
`single_select`), pulled from `custom_field_values`.

Watch the varchar(30) cap.

### 4. Platform entity-type list — `settings/custom-fields/entity-types.ts`

Today a hardcoded 4-entry `ENTITY_TYPES` array. Becomes static built-ins plus
whatever `useCustomObjects()` returns, so the existing custom-fields settings
page can target custom objects with no other change.

## API surface (app-api)

Two clearly separated surfaces. **No per-object code generation** — one generic
route file handles every object.

### Definition surface — `weldobjects:manage`

```
GET    /api/custom-objects
POST   /api/custom-objects
GET    /api/custom-objects/:id
PUT    /api/custom-objects/:id
DELETE /api/custom-objects/:id
GET    /api/custom-objects/:id/links
POST   /api/custom-objects/:id/links
PUT    /api/custom-objects/:id/links/:linkId
DELETE /api/custom-objects/:id/links/:linkId
```

**Fields need no new endpoints at all.** The existing
`/api/custom-fields?entityType=co_machine` surface already does everything.
That is the single biggest saving from the EAV decision.

### Data surface — `weldobjects:<slug>:*`

```
GET    /api/objects/:slug/records            cursor paginated, sort=custom:<field>
POST   /api/objects/:slug/records
GET    /api/objects/:slug/records/:id
PATCH  /api/objects/:slug/records/:id
DELETE /api/objects/:slug/records/:id

GET    /api/objects/:slug/records/:id/links/:linkSlug
POST   /api/objects/:slug/records/:id/links/:linkSlug/:targetId
DELETE /api/objects/:slug/records/:id/links/:linkSlug/:targetId

GET    /api/related/:entityType/:entityId/custom-objects
```

That last one is the reverse lookup: given a Customer, return every custom
object record linked to it, grouped by link. It is what lets a Customer detail
page grow a "Machines" panel without CRM code knowing custom objects exist.

Permission enforcement is dynamic — resolve `:slug` first, then call
`requirePermission(\`weldobjects:${slug}:read\`)`. Since `requirePermission`
returns a middleware closure, this needs a small wrapper that reads the param at
request time rather than route-registration time. Write it once in
`middleware/custom-object-permission.ts`.

Standard response envelope, `cursorPagination()`, `publishCustomObjectEvent` on
every mutation — same rules as every other route.

## Frontend (`apps/web/platform`)

TanStack Router is file-based and static, but custom objects are dynamic. That
resolves to exactly **two** runtime route files:

```
src/routes/_dashboard/objects/$slug/index.tsx       → list
src/routes/_dashboard/objects/$slug/$recordId.tsx   → detail
```

Components live in `app/weldobjects/`:

- `list-page.tsx` — wraps `components/entity-grid/`, columns from
  `to-grid-columns.ts` (already written), per-object `grid_views` keyed on
  `gridName = co_<slug>`.
- `record-detail.tsx` — field groups + related-link panels.
- `record-form.tsx` — create/edit driven by field definitions.
- `related-panel.tsx` — used on both custom object detail pages and, later,
  built-in detail pages.
- `hooks/use-custom-objects.ts`, `hooks/queries/use-custom-object-queries.ts`.

Settings lives in `app/settings/custom-objects/`: object list, object builder,
link builder. The **field** editor is the existing
`settings/custom-fields/field-definition-dialog.tsx` pointed at
`entityType=co_<slug>` — do not fork it.

Sidebar: a `use-weldobjects-sidebar-items.tsx` following the established
per-module hook pattern (`use-crm-sidebar-items.tsx` et al.), listing active
objects. Whether WeldObjects is a top-level module or a group depends on how
`workspace_installed_apps` should treat it — see open questions.

Every new user-visible string needs `en` **and** `nl` entries in
`packages/core/i18n/src/locales/`. User-authored labels are data, not
translations — they are not localized.

## AI tools, MCP and external-api

Follow the WeldApps precedent exactly; it already solved this problem.
[tools/user-apps.ts](apps/workers/mcp-server/src/tools/user-apps.ts) loads a
per-caller dynamic tool list from `GET /v1/user-apps/agent-tools`, caches it in
isolate for 60s, and proxies execution through external-api so auth, validation
and entity events run on the canonical path.

Mirror it:

- external-api gains `/v1/custom-objects/*` (records CRUD + links) and
  `GET /v1/custom-objects/agent-tools`, gated by new `wsk_` scopes
  `custom-objects:read` / `custom-objects:write`.
- mcp-server gains `tools/custom-objects.ts` — same cache, same proxy executor.
- Per object with `enableAgentTools`, generate `list_<slug>`, `get_<slug>`,
  `create_<slug>`, `update_<slug>`, `delete_<slug>`, with input schemas derived
  from the field definitions.

Because MCP proxies through external-api rather than hitting the DB, permissions
and entity events come for free.

## Phasing

Each phase is backend-first and independently useful.

### Phase 0 — registry bridge

No user-visible change. Ships the four merge points: `publishCustomObjectEvent`,
`extraEntityTypes` on the event-name validators, the permission-catalog merge
hook, and the dynamic `ENTITY_TYPES` source. De-risks everything downstream and
is reviewable on its own.

### Phase 1 — objects, fields, records *(the shippable slice)*

`custom_objects` + `custom_object_records`. Definition API + data API. Settings
builder. Generic list + detail + create/edit UI. Permission keys enforced on
every route **and** merged into the role editor — without the role editor merge
nobody can grant access, so it belongs here, not later.

No relationships, no events, no search, no AI. A tenant can define "Machine",
give it fields, and manage records.

### Phase 2 — relationships

`custom_object_links` + `custom_object_relations`. Link builder in settings.
Related panels on custom object detail pages, then on built-in detail pages via
`/api/related/...`. Many-to-many, cascade rules, to-one enforcement.

This is the largest phase and the one most likely to want splitting: to-one
links first, many-to-many second.

### Phase 3 — entity events + workflows

Wire `publishCustomObjectEvent` into every mutation. Teach the workflow trigger
picker and its validation about custom object entity types. Audit log,
analytics, realtime and webhooks all come along for free once the events fire.

### Phase 4 — search

Registry merge, text projection, deep links. Gated per object by
`enableSearch`.

### Phase 5 — AI tools, MCP, external-api

The full dynamic tool surface. Gated per object by `enableAgentTools` /
`enableExternalApi`.

## Risks and things that will bite

- **`search_index.entity_type` is varchar(30).** Cap slugs at 24 in the Zod
  schema or Phase 4 discovers the problem after Phase 1 shipped data.
- **Slug immutability.** Renaming a slug would orphan `custom_field_values`
  rows, `grid_views` rows, `search_index` rows and every granted permission
  string. Immutable from day one; only labels are editable. Say so in the UI.
- **Permission explosion.** 5 keys per object. 40 objects is 200 checkboxes.
  Group and collapse them, and consider an object-level "full access" shortcut.
- **EAV read cost on wide objects.** An object with 60 fields pivots 60 rows per
  record. The batch loaders handle a page fine; a 10k-row CSV export will not.
  Export is out of scope for v1 — when it lands, it needs a dedicated pivoted
  query, not the hydrate path.
- **Deleting an object type.** Soft-delete the definition, but the values,
  relations, search rows and grid views are real data. Needs an explicit
  cascade job and a confirmation flow that states the row count. Do not leave
  this to `deletedAt` alone.
- **Overlap with WeldApps `app_records`.** Both are schemaless user-defined
  storage. They are genuinely different — WeldApps is for sandboxed iframe apps
  with their own bundles and billing; WeldObjects is native platform UI with no
  code. Worth stating in `CLAUDE.md` so the next person doesn't merge them.
- **Naming collision with `object_templates`.** That existing table is
  "named field-sets for the Company/People create form" and is unrelated. If
  WeldObjects ships, `object_templates` should probably be renamed
  `entity_create_templates` to stop the confusion.

## Open questions

1. ~~**Module registration.**~~ **Decided:** individual objects surface as their
   own sidebar entries ("Machines", not "WeldObjects → Machines"). The object
   builder lives under Settings; the objects themselves are top-level. The
   sidebar therefore has to accept dynamic entries sourced from a query rather
   than a static module list.
2. **Should built-in entities become link targets in both directions?** The plan
   supports custom → built-in. Built-in → built-in (e.g. a user-defined
   Company↔Company link) is a bigger conversation.
3. **Does a custom object need its own pipeline/stage concept**, or is a
   `single_select` field enough until kanban lands?
4. **Migration approval.** Four new tables means a tenant migration. Per
   `CLAUDE.md` that needs explicit sign-off before any migration file is
   written. See "Remaining work" below.

---

## Remaining work

### The tenant migration — generated, not yet applied

`0176_wild_night_thrasher.sql` was generated with explicit user approval and
creates exactly the four tables plus their indexes (no unrelated drift). It is
verified by the pglite suite, which builds a database from the migration files
and passes 925/925.

Still needs to be **applied** to tenant databases:

```bash
pnpm --filter migrate-databases migrate:dry-run
```

then `pnpm --filter migrate-databases db:migrate:tenants`. The deploy pipeline
runs migrations before workers deploy, so a merge to `main` handles this.

Code paths that could be reached before the migration lands degrade instead of
throwing, so a partially-rolled-out deploy is safe:

- `services/search/custom-object-documents.ts` swallows Postgres `42P01`
  (undefined_table) and reports "no custom objects". Without this the search
  **backfill walks every entity type in one loop**, so an exception there would
  strand invoices, tickets and everything else as collateral — not just custom
  objects.
- The roles permission-catalog merge and the webhook event-list merge both
  catch and fall back to the static catalog.

That guard is narrow on purpose: only `42P01` is swallowed, and the check walks
the `cause` chain because Drizzle wraps driver errors in a `DrizzleQueryError`
(a top-level-only check silently never matches, which is worse than no guard).

### Not verified in a browser

The platform SPA could not be exercised here: this worktree has no `.env`, so
`ClerkProvider` receives `publishableKey={undefined}` and throws before React
mounts. That is a pre-existing environment gap, unrelated to these changes.
Type-check, lint, the 925 app-api unit tests and en/nl translation parity all
pass; the UI itself has had no runtime exercise.

### Deferred by design

- **Kanban, detail-layout designer, CSV import/export, mass update.** Out of the
  agreed v1 scope. Note that export needs a dedicated pivoted query, not the
  hydrate path — see the EAV read-cost risk above.
- **Cascade on built-in deletes.** `applyTargetDeleteCascade` is wired into the
  custom-object record delete path, but built-in entity deletes (deleting a
  Customer that has Machines linked) do not call it — that would mean touching
  every first-party delete route. Both `listRelated` and `listReversePanels`
  drop unresolvable ids, so the visible symptom is a silently vanishing panel
  entry rather than a dangling reference.
- **`object_templates` rename.** Still worth doing to stop the name collision.

## What shipped where

| Phase | Landed in |
|---|---|
| 0 — registry bridge | `packages/core/entity-events/src/custom-objects.ts`, `events/index.ts` (`extraEntityTypes`), `packages/core/permissions/src/custom-objects.ts` + catalog/role grants |
| 1 — objects, fields, records | `packages/core/db/src/schema/custom-objects.ts`, `packages/core/db/src/lib/custom-objects.ts`, `app-api/routes/custom-objects/`, `app-api/routes/custom-object-records/`, `app-api/middleware/custom-object.ts` |
| 2 — relationships | `app-api/services/custom-object-links.ts`, `custom-object-targets.ts`, `routes/custom-object-links/` |
| 3 — events + workflows | `publishCustomObjectEvent` wired into every record mutation; webhook event picker merge |
| 4 — search | `app-api/services/search/custom-object-documents.ts`, indexer + backfill hooks |
| 5 — AI/MCP/external-api | `external-api/routes/v1/custom-objects.ts` (mirrored into mcp-server), `mcp-server/tools/custom-objects.ts` |
| UI | `platform/app/weldobjects/`, `platform/app/settings/custom-objects/`, `hooks/queries/use-custom-objects-queries.ts`, sidebar `appType: 'object'`, `i18n en/nl weldobjects` |
