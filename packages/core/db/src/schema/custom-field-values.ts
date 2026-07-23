import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  doublePrecision,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Custom field VALUES — the typed, one-cell-per-value store that replaces the
 * per-entity `custom_fields` JSONB blob.
 *
 * Every row holds a single custom field value for a single parent entity. The
 * value lives in exactly one of the typed columns below (which one is decided
 * by the parent definition's `fieldType`); the rest stay null. Because each
 * value is its own indexable cell, list surfaces can sort, filter, and
 * aggregate on custom fields with plain SQL — impossible with the old blob.
 *
 * Keyed by `fieldId` (the immutable definition id), NOT the slug, so renaming
 * a field never orphans its data.
 *
 * Tenant DB only (per-workspace) — no `workspaceId`, mirroring
 * `custom_field_definitions`.
 */
export const customFieldValues = pgTable(
  'custom_field_values',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    // The definition this value belongs to (custom_field_definitions.id).
    fieldId: varchar('field_id', { length: 30 }).notNull(),
    // Denormalized from the definition so we can scope/query without a join.
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    // The parent row (companies.id / people.id / tasks.id / ...).
    entityId: varchar('entity_id', { length: 30 }).notNull(),

    // Typed value columns — populate the one matching the definition fieldType.
    // text | textarea | url | email | phone | single_select
    valueText: text('value_text'),
    // number | currency | rating
    valueNumber: doublePrecision('value_number'),
    // date
    valueDate: timestamp('value_date'),
    // boolean
    valueBool: boolean('value_bool'),
    // multi_select (string[]) | file (metadata) | any structured value
    valueJson: jsonb('value_json').$type<unknown>(),
    // user_ref | entity_ref — the referenced record id.
    valueRef: varchar('value_ref', { length: 30 }),
  },
  (table) => [
    // One value row per field per entity (single-value semantics).
    uniqueIndex('cfv_entity_field_idx').on(table.entityType, table.entityId, table.fieldId),
    // Fetch every value for a given entity row.
    index('cfv_entity_idx').on(table.entityType, table.entityId),
    // Per-type composite indexes powering sort/filter on a single field.
    index('cfv_field_text_idx').on(table.fieldId, table.valueText),
    index('cfv_field_number_idx').on(table.fieldId, table.valueNumber),
    index('cfv_field_date_idx').on(table.fieldId, table.valueDate),
    index('cfv_field_bool_idx').on(table.fieldId, table.valueBool),
    index('cfv_field_ref_idx').on(table.fieldId, table.valueRef),
  ],
);

export type CustomFieldValue = typeof customFieldValues.$inferSelect;
export type NewCustomFieldValue = typeof customFieldValues.$inferInsert;
