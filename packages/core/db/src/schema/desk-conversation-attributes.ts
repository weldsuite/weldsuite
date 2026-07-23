import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

/**
 * WeldDesk v2 — conversation data attribute (CvDA) definitions.
 *
 * Workspace-defined schema for desk_conversations.customAttributes.
 * Values are stored on the conversation row; this table is the definition
 * (type, options, required-before-close, conditional visibility).
 */

export type DeskAttributeDataType =
  | 'text'
  | 'list'
  | 'number'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'reference'
  | 'files';

export const deskConversationAttributes = pgTable(
  'desk_conversation_attributes',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    dataType: varchar('data_type', { length: 10 }).$type<DeskAttributeDataType>().notNull(),
    /** Options for dataType=list. */
    listOptions: jsonb('list_options').$type<{ id: string; label: string }[]>(),
    /** Entity type for dataType=reference (e.g. 'contact', 'order'). */
    referenceType: varchar('reference_type', { length: 50 }),
    /** Enforced in the inbox UI before closing (not at the API layer). */
    requiredBeforeClose: boolean('required_before_close').notNull().default(false),
    /** Conditional visibility: only show when parent attribute has a given value. */
    conditionalParentId: varchar('conditional_parent_id', { length: 30 }),
    conditionalParentValue: jsonb('conditional_parent_value').$type<unknown>(),
    order: integer('order').notNull().default(0),
    archived: boolean('archived').notNull().default(false),
  },
  (table) => [index('desk_conversation_attributes_order_idx').on(table.order)],
);

export type DeskConversationAttribute = typeof deskConversationAttributes.$inferSelect;
export type NewDeskConversationAttribute = typeof deskConversationAttributes.$inferInsert;
