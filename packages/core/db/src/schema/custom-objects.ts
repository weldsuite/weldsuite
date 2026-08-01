import { sql } from 'drizzle-orm';
import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ============================================================================
// WELDOBJECTS — USER-DEFINED CUSTOM OBJECTS (TENANT DATABASE)
//
// A workspace admin defines an object type ("Machine", "Certification"), gives
// it fields and relationships, and gets a real module — list, detail, forms,
// permissions, workflows, search, AI tools — with no migration and no deploy.
//
// The field machinery is NOT reimplemented here. A custom object's fields are
// ordinary `custom_field_definitions` rows and its values are ordinary
// `custom_field_values` rows, both keyed on `entity_type = <entityKey>`. That
// column was always a free-form varchar, so the storage layer already accepted
// user-defined entity types; these tables are what finally give that string a
// definition behind it.
//
// Reusing the EAV store means the typed value columns, the per-type indexes and
// the already-written sort/filter fragment builders in
// app-api/src/services/custom-field-query.ts all apply to custom objects on day
// one, and the field editor UI works by pointing at `entityType=co_<slug>`.
//
// Tenant DB is per-workspace, so no `workspaceId` column anywhere here — same
// model as custom_field_definitions and workspace_installed_apps.
// ============================================================================

/**
 * The object TYPE — one row per user-defined object.
 *
 * `entityKey` (`co_<slug>`) is the join key that ties this definition to every
 * other subsystem: custom_field_definitions.entity_type,
 * custom_field_values.entity_type, search_index.entity_type, grid_views.grid_name,
 * and the entity type on the event wire (`co_machine:created`).
 *
 * `slug` is IMMUTABLE after creation. A rename would orphan EAV values, grid
 * views, search rows and every permission string a role has been granted, none
 * of which can be fixed up transactionally across a tenant. Labels are freely
 * editable; the key is not. This mirrors `custom_field_definitions.entityType`,
 * which is likewise omitted from its update schema.
 *
 * Slug length is capped at 24 characters — NOT a style choice.
 * `search_index.entity_type` is varchar(30) and must hold `co_` + slug.
 */
export const customObjects = pgTable(
  'custom_objects',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),

    /** Immutable. `^[a-z][a-z0-9_]{0,23}$`. */
    slug: varchar('slug', { length: 24 }).notNull(),
    /** Derived `co_<slug>`. Stored rather than computed so it can be indexed
     *  and joined without recomputing the prefix at every call site. */
    entityKey: varchar('entity_key', { length: 30 }).notNull(),

    labelSingular: varchar('label_singular', { length: 100 }).notNull(),
    labelPlural: varchar('label_plural', { length: 100 }).notNull(),
    description: varchar('description', { length: 500 }),

    /** lucide-react icon name, rendered in the sidebar and record headers. */
    icon: varchar('icon', { length: 50 }).notNull().default('Box'),
    /** Tailwind-ish accent token for the sidebar entry and badges. */
    color: varchar('color', { length: 20 }),

    /**
     * `custom_field_definitions.id` of the field used as a record's display
     * name. Nullable because an object can exist before it has any fields;
     * records created while it is null fall back to their id for a title.
     */
    titleFieldId: varchar('title_field_id', { length: 30 }),

    /** 'draft' | 'active' | 'disabled'. Only 'active' objects reach the sidebar. */
    status: varchar('status', { length: 20 }).notNull().default('draft'),

    // ── Integration switches ────────────────────────────────────────────
    // Per-object opt-in is what keeps four platform-wide integrations from
    // becoming a liability. A workspace with 30 objects should not get 150 MCP
    // tools and 30 search indexes by default.
    //
    // Events default ON: fire-and-forget, no per-object cost, and workflows are
    // the most-requested integration. The other three default OFF.
    enableEvents: boolean('enable_events').notNull().default(true),
    enableSearch: boolean('enable_search').notNull().default(false),
    enableAgentTools: boolean('enable_agent_tools').notNull().default(false),
    enableExternalApi: boolean('enable_external_api').notNull().default(false),

    /** Default grid layout: visible column keys in order. Per-USER overrides
     *  live in `grid_views` keyed on gridName = entityKey. */
    listConfig: jsonb('list_config')
      .$type<{ columns?: string[]; defaultSort?: { key: string; direction: 'asc' | 'desc' } }>()
      .notNull()
      .default({}),

    /** Sidebar ordering among other custom objects. */
    sortOrder: integer('sort_order').notNull().default(0),

    createdBy: varchar('created_by', { length: 255 }),
  },
  (table) => [
    uniqueIndex('custom_objects_slug_idx').on(table.slug),
    uniqueIndex('custom_objects_entity_key_idx').on(table.entityKey),
    index('custom_objects_status_idx').on(table.status, table.sortOrder),
  ],
);

export type CustomObject = typeof customObjects.$inferSelect;
export type NewCustomObject = typeof customObjects.$inferInsert;

/**
 * A RECORD of a custom object — deliberately thin.
 *
 * Field values are not here; they live in `custom_field_values` keyed on
 * `(entity_type = entityKey, entity_id = this.id)`. What IS here is the
 * bookkeeping that every list query needs and that would be painful to pivot
 * out of the EAV table on every read.
 *
 * `title` is the one deliberate denormalization: a copy of the value of the
 * object's `titleFieldId` field, maintained on write. Without it, rendering a
 * list of 50 records, a picker dropdown, a related panel, a search result or a
 * workflow payload would each require an EAV pivot purely to get a label. With
 * it, they are a single indexed column read.
 */
export const customObjectRecords = pgTable(
  'custom_object_records',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),

    objectId: varchar('object_id', { length: 30 }).notNull(),
    /** Denormalized `custom_objects.entity_key` — every list query filters on
     *  it, and carrying it here avoids a join on the hottest path. */
    entityKey: varchar('entity_key', { length: 30 }).notNull(),

    /**
     * Denormalized display name — see the docblock above.
     *
     * Bounded rather than `text` because `cor_entity_key_title_idx` puts it in
     * a btree, and a btree tuple that exceeds ~2704 bytes fails AT INSERT TIME.
     * The value is copied from a user-configured field, so an unbounded column
     * would let a long textarea value make the record unsaveable. 500 matches
     * `tasks.title` and `helpdesk_articles.title`; `resolveRecordTitle` already
     * truncates to the same length.
     */
    title: varchar('title', { length: 500 }),

    /** Clerk user id. Drives `weldobjects:<slug>:scope:all` owner scoping,
     *  the same way `crm_leads.ownerId` drives `leads:scope:all`. */
    ownerId: varchar('owner_id', { length: 255 }),
    createdBy: varchar('created_by', { length: 255 }),
    updatedBy: varchar('updated_by', { length: 255 }),
  },
  (table) => [
    // The list query: every record of one object, newest first.
    index('cor_entity_key_created_idx').on(table.entityKey, table.createdAt),
    // Owner-scoped list for users without scope:all.
    index('cor_entity_key_owner_idx').on(table.entityKey, table.ownerId),
    // Title search + title sort.
    index('cor_entity_key_title_idx').on(table.entityKey, table.title),
    // Cascade target when an object type is deleted.
    index('cor_object_id_idx').on(table.objectId),
  ],
);

export type CustomObjectRecord = typeof customObjectRecords.$inferSelect;
export type NewCustomObjectRecord = typeof customObjectRecords.$inferInsert;

/**
 * A relationship DEFINITION between a custom object and something else.
 *
 * `targetEntityKey` may be another custom object's `co_<slug>` OR a built-in
 * platform entity type ('company', 'person', 'opportunity', 'ticket', …).
 * Pointing at built-ins is the motivating case — "Machines belonging to this
 * Customer" is what people actually want; custom-to-custom is the rarer one.
 *
 * Note this SUPERSEDES the `entity_ref` custom field type for custom objects.
 * `entity_ref` stores a single id in `custom_field_values.value_ref` with no
 * reverse index by target type and no many-to-many; offering both would be two
 * mechanisms for one concept. `entity_ref` is unchanged for custom fields on
 * built-in entities.
 */
export const customObjectLinks = pgTable(
  'custom_object_links',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),

    /** URL/API segment for the related list, e.g. 'service_visits'. */
    slug: varchar('slug', { length: 50 }).notNull(),

    /** Always a custom object's entity key — links are owned by custom objects. */
    sourceEntityKey: varchar('source_entity_key', { length: 30 }).notNull(),
    /** Custom object entity key OR a built-in entity type. */
    targetEntityKey: varchar('target_entity_key', { length: 30 }).notNull(),

    /** 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many' */
    cardinality: varchar('cardinality', { length: 20 }).notNull(),

    /** Panel heading shown on the TARGET's detail page (listing sources). */
    sourceLabel: varchar('source_label', { length: 100 }).notNull(),
    /** Panel heading shown on the SOURCE's detail page (listing targets). */
    targetLabel: varchar('target_label', { length: 100 }).notNull(),

    /** 'restrict' | 'cascade' | 'set_null' — applied when a TARGET row dies. */
    onDelete: varchar('on_delete', { length: 20 }).notNull().default('set_null'),
    required: boolean('required').notNull().default(false),

    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => [
    // PARTIAL, unlike the two unique indexes on `custom_objects`. Deleting a
    // relationship should free its name for reuse — the link editor already
    // filters soft-deleted rows, so a full unique index would reserve the slug
    // forever and surface as an unexplained 500 on the next create.
    //
    // Object slugs are the opposite case and stay fully unique on purpose: a
    // deleted object's `custom_field_values` rows are keyed on its derived
    // entity key, so reusing the slug would silently adopt them.
    uniqueIndex('col_source_slug_idx')
      .on(table.sourceEntityKey, table.slug)
      .where(sql`${table.deletedAt} IS NULL`),
    index('col_source_idx').on(table.sourceEntityKey),
    index('col_target_idx').on(table.targetEntityKey),
  ],
);

export type CustomObjectLink = typeof customObjectLinks.$inferSelect;
export type NewCustomObjectLink = typeof customObjectLinks.$inferInsert;

/**
 * A relationship EDGE — one row per actual connection.
 *
 * A single edge table serves all four cardinalities. To-one cardinality
 * (one_to_one, many_to_one) is enforced in the service layer inside a
 * transaction, NOT by a unique index: cardinality lives on the link row, so no
 * single partial index over this table can express "unique per source, but only
 * when the parent link is to-one". Keep that enforcement in exactly one place
 * (services/custom-object-links.ts) and never inline an insert elsewhere.
 *
 * `(target_entity_key, target_id)` is the index that earns its keep: it answers
 * "every custom object record linked to THIS customer" without the caller
 * knowing which links exist, which is what lets a built-in detail page grow
 * custom-object panels without CRM code knowing custom objects exist.
 */
export const customObjectRelations = pgTable(
  'custom_object_relations',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    createdBy: varchar('created_by', { length: 255 }),

    linkId: varchar('link_id', { length: 30 }).notNull(),

    sourceEntityKey: varchar('source_entity_key', { length: 30 }).notNull(),
    sourceId: varchar('source_id', { length: 30 }).notNull(),
    targetEntityKey: varchar('target_entity_key', { length: 30 }).notNull(),
    targetId: varchar('target_id', { length: 30 }).notNull(),

    /** Manual ordering within a related list. */
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => [
    uniqueIndex('cor_rel_link_source_target_idx').on(table.linkId, table.sourceId, table.targetId),
    // Forward traversal: targets of this source.
    index('cor_rel_link_source_idx').on(table.linkId, table.sourceId),
    // Reverse traversal within a known link.
    index('cor_rel_link_target_idx').on(table.linkId, table.targetId),
    // Reverse traversal WITHOUT knowing the link — powers related panels on
    // built-in detail pages. See docblock.
    index('cor_rel_target_idx').on(table.targetEntityKey, table.targetId),
  ],
);

export type CustomObjectRelation = typeof customObjectRelations.$inferSelect;
export type NewCustomObjectRelation = typeof customObjectRelations.$inferInsert;
