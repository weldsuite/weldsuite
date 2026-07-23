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

// Canned response types
export type CannedResponseScope = 'personal' | 'team' | 'department' | 'global';

export interface MacroAction {
  type: 'set_status' | 'set_priority' | 'assign_to' | 'add_tag' | 'send_email';
  value: unknown;
}

export const helpdeskCannedResponses = pgTable('helpdesk_canned_responses', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Basic info
  name: varchar('name', { length: 255 }).notNull(),
  subject: varchar('subject', { length: 500 }),
  content: text('content').notNull(),
  category: varchar('category', { length: 100 }),

  // Availability
  scope: varchar('scope', { length: 20 }).notNull().default('personal'),
  agentId: varchar('agent_id', { length: 30 }),
  teamId: varchar('team_id', { length: 30 }),
  departmentId: varchar('department_id', { length: 30 }),

  // Usage
  usageCount: integer('usage_count').default(0),
  lastUsedAt: timestamp('last_used_at'),

  // Shortcuts
  shortcut: varchar('shortcut', { length: 50 }),
  keywords: jsonb('keywords').$type<string[]>(),

  // Actions
  actions: jsonb('actions').$type<MacroAction[]>(),

  // Status
  isActive: boolean('is_active').notNull().default(true),
}, (table) => [
  index('helpdesk_canned_responses_scope_idx').on(table.scope),
  index('helpdesk_canned_responses_agent_idx').on(table.agentId),
  index('helpdesk_canned_responses_department_idx').on(table.departmentId),
  index('helpdesk_canned_responses_category_idx').on(table.category),
  index('helpdesk_canned_responses_is_active_idx').on(table.isActive),
  index('helpdesk_canned_responses_shortcut_idx').on(table.shortcut),
]);

export type HelpdeskCannedResponse = typeof helpdeskCannedResponses.$inferSelect;
export type NewHelpdeskCannedResponse = typeof helpdeskCannedResponses.$inferInsert;
