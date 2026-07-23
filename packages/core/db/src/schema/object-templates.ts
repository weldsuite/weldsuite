import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  integer,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Object Templates — named field-sets used when creating Companies or People.
 *
 * `entityType` matches the values in settings/custom-fields/entity-types.ts
 * ('company', 'person'). `fields` is the ordered array of field slugs that
 * appear in the create form when this template is picked. Slugs may refer to
 * built-in columns (e.g. 'name', 'industry') OR custom-field definition
 * slugs — the front-end resolves both against its field catalog.
 */
export const objectTemplates = pgTable('object_templates', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityType: varchar('entity_type', { length: 50 }).notNull(),
  name: varchar('name', { length: 150 }).notNull(),
  slug: varchar('slug', { length: 150 }).notNull(),
  description: varchar('description', { length: 500 }),
  fields: jsonb('fields').$type<string[]>().notNull().default([]),
  isDefault: boolean('is_default').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
}, (table) => [
  index('object_templates_entity_type_idx').on(table.entityType),
  uniqueIndex('object_templates_entity_type_slug_idx').on(table.entityType, table.slug),
]);

export type ObjectTemplate = typeof objectTemplates.$inferSelect;
export type NewObjectTemplate = typeof objectTemplates.$inferInsert;
