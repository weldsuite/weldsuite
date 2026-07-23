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

// SLA types
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent' | 'critical';
export type OperationalHours = 'business' | '24x7' | 'custom';

export interface SLACondition {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than';
  value: unknown;
}

export interface SLATarget {
  priority: TicketPriority;
  time: number; // minutes
  notifyAt?: number[]; // percentages (e.g., [50, 75, 90])
}

export interface SLAReminder {
  type: 'before_breach' | 'after_breach';
  time: number; // minutes
  recipients: ('assignee' | 'manager' | 'customer')[];
}

export interface EscalationRule {
  condition: 'sla_breach' | 'no_response' | 'unassigned' | 'custom';
  afterMinutes: number;
  escalateTo: 'manager' | 'next_tier' | 'specific_agent';
  escalateToId?: string;
  notifyCustomer?: boolean;
}

export interface BusinessHours {
  timezone: string;
  monday?: { isOpen: boolean; openTime?: string; closeTime?: string };
  tuesday?: { isOpen: boolean; openTime?: string; closeTime?: string };
  wednesday?: { isOpen: boolean; openTime?: string; closeTime?: string };
  thursday?: { isOpen: boolean; openTime?: string; closeTime?: string };
  friday?: { isOpen: boolean; openTime?: string; closeTime?: string };
  saturday?: { isOpen: boolean; openTime?: string; closeTime?: string };
  sunday?: { isOpen: boolean; openTime?: string; closeTime?: string };
  holidays?: { date: string; name: string; isRecurring?: boolean }[];
}

export const helpdeskSlas = pgTable('helpdesk_slas', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Basic info
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),

  // Conditions
  conditions: jsonb('conditions').$type<SLACondition[]>(),
  isDefault: boolean('is_default').default(false),

  // Targets
  firstResponseTime: jsonb('first_response_time').$type<SLATarget[]>(),
  resolutionTime: jsonb('resolution_time').$type<SLATarget[]>(),
  updateTime: jsonb('update_time').$type<SLATarget[]>(),

  // Business Hours
  operationalHours: varchar('operational_hours', { length: 20 }).notNull().default('business'),
  businessHours: jsonb('business_hours').$type<BusinessHours>(),

  // Escalation
  escalationRules: jsonb('escalation_rules').$type<EscalationRule[]>(),

  // Status
  isActive: boolean('is_active').notNull().default(true),
  priority: integer('priority').default(0),

  // Reminders
  reminders: jsonb('reminders').$type<SLAReminder[]>(),
}, (table) => [
  index('helpdesk_slas_is_active_idx').on(table.isActive),
  index('helpdesk_slas_is_default_idx').on(table.isDefault),
  index('helpdesk_slas_priority_idx').on(table.priority),
]);

export type HelpdeskSla = typeof helpdeskSlas.$inferSelect;
export type NewHelpdeskSla = typeof helpdeskSlas.$inferInsert;
