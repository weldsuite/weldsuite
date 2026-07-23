import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { mailAccounts } from './mail-accounts';

// Rule match type enum
export const mailRuleMatchTypeEnum = pgEnum('mail_rule_match_type', [
  'all',
  'any',
]);

// Rule scope enum
export const mailRuleScopeEnum = pgEnum('mail_rule_scope', [
  'incoming',
  'outgoing',
  'all',
]);

// Condition field type
export type MailRuleConditionField =
  | 'from'
  | 'to'
  | 'cc'
  | 'subject'
  | 'body'
  | 'has_attachment'
  | 'size'
  | 'date'
  | 'is_spam'
  | 'priority';

// Condition operator type
export type MailRuleConditionOperator =
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'not_equals'
  | 'starts_with'
  | 'ends_with'
  | 'greater_than'
  | 'less_than'
  | 'is_true'
  | 'is_false';

// Rule condition interface (stored as JSONB)
export interface MailRuleCondition {
  field: MailRuleConditionField;
  operator: MailRuleConditionOperator;
  value: string | string[];
}

// Action type
export type MailRuleActionType =
  | 'move_to_folder'
  | 'copy_to_folder'
  | 'delete'
  | 'mark_as_read'
  | 'mark_as_unread'
  | 'star'
  | 'add_label'
  | 'remove_label'
  | 'forward_to'
  | 'auto_reply'
  | 'flag'
  | 'archive';

// Rule action interface (stored as JSONB)
export interface MailRuleAction {
  type: MailRuleActionType;
  value?: string;
  folderId?: string;
  labelId?: string;
  email?: string;
  templateId?: string;
}

// Mail Rules table
export const mailRules = pgTable('mail_rules', {
  id: varchar('id', { length: 30 }).primaryKey(),
  accountId: varchar('account_id', { length: 30 }).notNull().references(() => mailAccounts.id),

  // Rule Information
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),

  // Conditions
  conditions: jsonb('conditions').$type<MailRuleCondition[]>().notNull(),
  matchType: mailRuleMatchTypeEnum('match_type').notNull().default('all'),

  // Actions
  actions: jsonb('actions').$type<MailRuleAction[]>().notNull(),

  // Settings
  isActive: boolean('is_active').notNull().default(true),
  stopProcessing: boolean('stop_processing').default(false), // Stop other rules after this
  priority: integer('priority').default(0),
  applyToExisting: boolean('apply_to_existing').default(false),

  // Statistics
  appliedCount: integer('applied_count').default(0),
  lastAppliedAt: timestamp('last_applied_at'),

  // Scope
  scope: mailRuleScopeEnum('scope').default('incoming'),
  folders: jsonb('folders').$type<string[]>(), // Only apply to specific folders

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('mail_rules_account_id_idx').on(table.accountId),
  index('mail_rules_is_active_idx').on(table.isActive),
  index('mail_rules_priority_idx').on(table.priority),
]);

export type MailRule = typeof mailRules.$inferSelect;
export type NewMailRule = typeof mailRules.$inferInsert;
