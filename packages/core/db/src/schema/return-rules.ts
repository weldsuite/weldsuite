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

export interface RuleCondition {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than' | 'in' | 'not_in';
  value: unknown;
}

export interface RuleAction {
  type: 'auto_approve' | 'require_approval' | 'apply_fee' | 'notify' | 'set_carrier';
  value?: unknown;
  config?: Record<string, unknown>;
}

export const returnRules = pgTable('return_rules', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Rule Details
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),

  // Status
  isActive: boolean('is_active').default(true),
  priority: integer('priority').default(0),

  // Conditions
  conditions: jsonb('conditions').$type<RuleCondition[]>(),
  conditionLogic: varchar('condition_logic', { length: 10 }).default('all'), // 'all' | 'any'

  // Actions
  actions: jsonb('actions').$type<RuleAction[]>(),

  // Return Window
  returnWindowDays: integer('return_window_days').default(30),

  // Usage
  usageCount: integer('usage_count').default(0),
  lastUsedAt: timestamp('last_used_at'),
}, (table) => [
  index('return_rules_is_active_idx').on(table.isActive),
  index('return_rules_priority_idx').on(table.priority),
]);

export type ReturnRule = typeof returnRules.$inferSelect;
export type NewReturnRule = typeof returnRules.$inferInsert;
