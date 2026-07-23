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

export interface BusinessHours {
  timezone: string;
  monday?: DayHours;
  tuesday?: DayHours;
  wednesday?: DayHours;
  thursday?: DayHours;
  friday?: DayHours;
  saturday?: DayHours;
  sunday?: DayHours;
  holidays?: Holiday[];
}

export interface DayHours {
  isOpen: boolean;
  openTime?: string;
  closeTime?: string;
  breaks?: { start: string; end: string }[];
}

export interface Holiday {
  date: string;
  name: string;
  isRecurring?: boolean;
}

export interface EscalationRule {
  condition: 'sla_breach' | 'no_response' | 'unassigned' | 'custom';
  afterMinutes: number;
  escalateTo: 'manager' | 'next_tier' | 'specific_agent';
  escalateToId?: string;
  notifyCustomer?: boolean;
}

export const helpdeskDepartments = pgTable('helpdesk_departments', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Basic info
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  email: varchar('email', { length: 255 }),

  // Manager
  managerId: varchar('manager_id', { length: 30 }),
  managerName: varchar('manager_name', { length: 255 }),

  // Team
  agentIds: jsonb('agent_ids').$type<string[]>(),
  agentCount: integer('agent_count').default(0),

  // Settings
  autoAssignment: boolean('auto_assignment').default(false),
  roundRobinAssignment: boolean('round_robin_assignment').default(false),
  escalationRules: jsonb('escalation_rules').$type<EscalationRule[]>(),

  // Business Hours
  businessHours: jsonb('business_hours').$type<BusinessHours>(),
  replyTime: varchar('reply_time', { length: 50 }),

  // Categories
  categories: jsonb('categories').$type<string[]>(),
  defaultPriority: varchar('default_priority', { length: 20 }).default('medium'),

  // Status
  isActive: boolean('is_active').notNull().default(true),

  // Sorting
  sortOrder: integer('sort_order').default(0),
}, (table) => [
  index('helpdesk_departments_manager_idx').on(table.managerId),
  index('helpdesk_departments_is_active_idx').on(table.isActive),
]);

export type HelpdeskDepartment = typeof helpdeskDepartments.$inferSelect;
export type NewHelpdeskDepartment = typeof helpdeskDepartments.$inferInsert;
