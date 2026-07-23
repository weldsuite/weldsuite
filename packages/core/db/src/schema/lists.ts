import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Lists — manual or filter-defined groups of Companies XOR People.
 *
 * Each list is scoped to a single entity type via `kind`. Mixed lists are
 * intentionally not supported — every operation on a list (filter, bulk
 * action, export, smart-list filter) is type-specific, and supporting both
 * in one list means branching everywhere instead of once at list creation.
 *
 * Replaces the legacy `customer_lists` + `customer_list_members` +
 * `contact_list_members` triple with one lists table + one members table.
 */
export const lists = pgTable('lists', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  name: varchar('name', { length: 255 }).notNull(),
  description: varchar('description', { length: 1000 }),
  color: varchar('color', { length: 50 }).notNull().default('bg-blue-500'),
  icon: varchar('icon', { length: 100 }).notNull().default('List'),

  /**
   * Immutable after create. Determines which identity table `list_members.entityId`
   * targets.
   */
  kind: varchar('kind', { length: 10 }).notNull(), // 'company' | 'person'

  /**
   * 'static'  — members maintained manually via list_members rows.
   * 'smart'   — members computed from filterRules at read time.
   */
  type: varchar('type', { length: 10 }).notNull().default('static'),
  filterRules: jsonb('filter_rules').$type<Record<string, unknown>>(),

  /**
   * For lists that were split during migration from a legacy mixed list
   * (one customer_lists row that held both customers and contacts). Points
   * at the paired list of the other kind. Null for natively-created lists.
   */
  linkedListId: varchar('linked_list_id', { length: 30 }),
}, (table) => [
  index('lists_name_idx').on(table.name),
  index('lists_kind_idx').on(table.kind),
  index('lists_deleted_at_idx').on(table.deletedAt),
]);

export type List = typeof lists.$inferSelect;
export type NewList = typeof lists.$inferInsert;

/**
 * list_members — membership of a Company or Person in a List. The parent
 * list's `kind` discriminates which identity table `entityId` targets:
 *   - list.kind = 'company' → entityId → companies.id
 *   - list.kind = 'person'  → entityId → people.id
 *
 * No polymorphic FK constraint at the DB level — resolved at the service
 * layer. Within a single list, all rows target the same table, so reads are
 * a clean join.
 */
export const listMembers = pgTable('list_members', {
  id: varchar('id', { length: 30 }).primaryKey(),
  addedAt: timestamp('added_at').notNull().defaultNow(),
  addedBy: varchar('added_by', { length: 255 }),

  listId: varchar('list_id', { length: 30 }).notNull(),
  entityId: varchar('entity_id', { length: 30 }).notNull(),
}, (table) => [
  index('list_members_list_idx').on(table.listId),
  index('list_members_entity_idx').on(table.entityId),
  uniqueIndex('list_members_unique').on(table.listId, table.entityId),
]);

export type ListMember = typeof listMembers.$inferSelect;
export type NewListMember = typeof listMembers.$inferInsert;
