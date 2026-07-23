import { sql } from 'drizzle-orm';
import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const customFieldDefinitions = pgTable('custom_field_definitions', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityType: varchar('entity_type', { length: 50 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull(),
  description: varchar('description', { length: 500 }),
  fieldType: varchar('field_type', { length: 30 }).notNull(),
  options: jsonb('options').$type<{ label: string; value: string; color?: string }[]>(),
  config: jsonb('config').$type<Record<string, unknown>>(),
  required: boolean('required').default(false),
  sortOrder: integer('sort_order').default(0),
  group: varchar('group', { length: 100 }),

  // Scopes a definition to one helpdesk_ticket_types row. NULL means
  // "applies to all rows of this entityType" (unchanged behavior).
  ticketTypeId: varchar('ticket_type_id', { length: 30 }),
}, (table) => [
  index('cfd_entity_type_idx').on(table.entityType),

  // Uniqueness is split into two PARTIAL indexes rather than one 3-column one.
  //
  // A plain `unique(entityType, slug, ticketTypeId)` would be wrong: Postgres
  // treats NULLs as distinct in a unique index, so every global definition
  // (ticketTypeId IS NULL) would compare unequal to every other and the
  // (entityType, slug) guarantee that exists today would silently vanish.
  //
  // `NULLS NOT DISTINCT` (PG15+) expresses this directly, but drizzle-orm
  // 0.45.1 only exposes `.nullsNotDistinct()` on the table-level `unique()`
  // constraint builder, not on `uniqueIndex()`. Two partial indexes give
  // identical semantics, are generated correctly by drizzle-kit, and work on
  // any Postgres version:
  //
  //   - global definitions  → (entityType, slug) unique among NULL-scoped rows
  //   - ticket-type-scoped  → (entityType, slug, ticketTypeId) unique among the rest
  //
  // so a slug may repeat across different ticket types, but never twice within
  // one ticket type, and never twice globally.
  uniqueIndex('cfd_entity_type_slug_idx')
    .on(table.entityType, table.slug)
    .where(sql`${table.ticketTypeId} IS NULL`),
  uniqueIndex('cfd_entity_type_slug_ticket_type_idx')
    .on(table.entityType, table.slug, table.ticketTypeId)
    .where(sql`${table.ticketTypeId} IS NOT NULL`),
]);

export type CustomFieldDefinition = typeof customFieldDefinitions.$inferSelect;
export type NewCustomFieldDefinition = typeof customFieldDefinitions.$inferInsert;
