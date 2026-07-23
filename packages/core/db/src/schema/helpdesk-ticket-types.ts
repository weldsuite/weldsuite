import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export interface TicketTypeFieldOption {
  label: string;
  value: string;
}

export interface TicketTypeFieldCondition {
  field: string; // key of the field to check
  operator: 'equals' | 'not_equals' | 'is_set' | 'is_not_set';
  value?: string;
}

export interface TicketTypeField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'date' | 'checkbox' | 'email' | 'url';
  required: boolean;
  placeholder?: string;
  options?: TicketTypeFieldOption[];
  helpText?: string;
  order: number;
  isDefault?: boolean;
  teammateVisible?: boolean;
  customerVisible?: boolean;
  conditions?: TicketTypeFieldCondition[];
}

export interface TicketTypeState {
  key: string;
  label: string;
  customerLabel: string;
}

export interface TicketTypeStateGroup {
  groupKey: 'submitted' | 'in_progress' | 'waiting_on_customer' | 'resolved';
  groupLabel: string;
  customerGroupLabel: string;
  states: TicketTypeState[];
}

export const helpdeskTicketTypes = pgTable('helpdesk_ticket_types', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  name: varchar('name', { length: 100 }).notNull(),
  description: varchar('description', { length: 500 }),
  icon: varchar('icon', { length: 50 }),
  color: varchar('color', { length: 20 }),

  category: varchar('category', { length: 30 }).default('customer'),
  fields: jsonb('fields').$type<TicketTypeField[]>(),
  states: jsonb('states').$type<TicketTypeStateGroup[]>(),
  disableAiAutofill: boolean('disable_ai_autofill').default(false),

  defaultPriority: varchar('default_priority', { length: 20 }),
  defaultAssigneeId: varchar('default_assignee_id', { length: 30 }),
  defaultDepartmentId: varchar('default_department_id', { length: 30 }),

  sortOrder: integer('sort_order').default(0),
  isActive: boolean('is_active').default(true).notNull(),
}, (table) => [
  index('helpdesk_ticket_types_active_idx').on(table.isActive),
  index('helpdesk_ticket_types_sort_idx').on(table.sortOrder),
]);

export type HelpdeskTicketType = typeof helpdeskTicketTypes.$inferSelect;
export type NewHelpdeskTicketType = typeof helpdeskTicketTypes.$inferInsert;
