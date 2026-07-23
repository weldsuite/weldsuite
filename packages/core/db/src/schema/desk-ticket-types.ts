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
import type { DeskTicketCategory } from './desk-conversations';

/**
 * WeldDesk v2 — ticket types, their form attributes, and custom states.
 *
 * A ticket is a desk_conversation with ticketTypeId/ticketStateId set.
 * - Ticket type: named template with a category + form schema + state set.
 * - Attributes: the form fields (typed, ordered, per-audience visibility).
 * - States: custom named states, each mapped to one of 4 fixed categories,
 *   with separate internal (teammate) and external (customer) labels.
 */

export const deskTicketTypes = pgTable(
  'desk_ticket_types',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    /** Emoji icon shown in pickers and the inbox. */
    icon: varchar('icon', { length: 20 }),
    category: varchar('category', { length: 15 }).$type<DeskTicketCategory>().notNull(),
    archived: boolean('archived').notNull().default(false),
  },
  (table) => [index('desk_ticket_types_category_idx').on(table.category)],
);

export type DeskTicketAttributeDataType =
  | 'string'
  | 'list'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'files';

export interface DeskTicketAttributeInputOptions {
  multiline?: boolean;
  /** Options for data_type=list. */
  listOptions?: { id: string; label: string }[];
}

export const deskTicketTypeAttributes = pgTable(
  'desk_ticket_type_attributes',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    ticketTypeId: varchar('ticket_type_id', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    dataType: varchar('data_type', { length: 10 }).$type<DeskTicketAttributeDataType>().notNull(),
    inputOptions: jsonb('input_options').$type<DeskTicketAttributeInputOptions>(),
    order: integer('order').notNull().default(0),
    /** Built-in title/description attributes vs workspace-defined. */
    isDefault: boolean('is_default').notNull().default(false),
    requiredToCreate: boolean('required_to_create').notNull().default(false),
    requiredToCreateForContacts: boolean('required_to_create_for_contacts').notNull().default(false),
    visibleOnCreate: boolean('visible_on_create').notNull().default(true),
    visibleToContacts: boolean('visible_to_contacts').notNull().default(true),
    archived: boolean('archived').notNull().default(false),
  },
  (table) => [index('desk_ticket_type_attributes_type_idx').on(table.ticketTypeId, table.order)],
);

/** The 4 fixed state categories every custom state maps to. */
export type DeskTicketStateCategory =
  | 'submitted'
  | 'in_progress'
  | 'waiting_on_customer'
  | 'resolved';

export const deskTicketStates = pgTable(
  'desk_ticket_states',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    ticketTypeId: varchar('ticket_type_id', { length: 30 }).notNull(),
    category: varchar('category', { length: 25 }).$type<DeskTicketStateCategory>().notNull(),
    /** Teammate-visible label, e.g. "With Dev Team". */
    internalLabel: varchar('internal_label', { length: 255 }).notNull(),
    /** Customer-visible label, e.g. "In progress". */
    externalLabel: varchar('external_label', { length: 255 }).notNull(),
    order: integer('order').notNull().default(0),
    archived: boolean('archived').notNull().default(false),
  },
  (table) => [index('desk_ticket_states_type_idx').on(table.ticketTypeId, table.order)],
);

export type DeskTicketType = typeof deskTicketTypes.$inferSelect;
export type NewDeskTicketType = typeof deskTicketTypes.$inferInsert;
export type DeskTicketTypeAttribute = typeof deskTicketTypeAttributes.$inferSelect;
export type NewDeskTicketTypeAttribute = typeof deskTicketTypeAttributes.$inferInsert;
export type DeskTicketState = typeof deskTicketStates.$inferSelect;
export type NewDeskTicketState = typeof deskTicketStates.$inferInsert;
