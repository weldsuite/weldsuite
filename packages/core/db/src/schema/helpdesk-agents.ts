import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  numeric,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Agent types
export type AgentRole = 'agent' | 'senior_agent' | 'team_lead' | 'supervisor' | 'admin';
export type AgentStatus = 'active' | 'inactive' | 'on_leave' | 'training';
export type AgentAvailability = 'available' | 'busy' | 'away' | 'offline';

export interface WorkingHours {
  monday?: DayHours;
  tuesday?: DayHours;
  wednesday?: DayHours;
  thursday?: DayHours;
  friday?: DayHours;
  saturday?: DayHours;
  sunday?: DayHours;
}

export interface DayHours {
  isOpen: boolean;
  openTime?: string;
  closeTime?: string;
  breaks?: { start: string; end: string }[];
}

export interface NotificationPreferences {
  newTicket?: boolean;
  ticketAssigned?: boolean;
  ticketUpdated?: boolean;
  customerReply?: boolean;
  ticketEscalated?: boolean;
  slaBreach?: boolean;
  channels?: ('email' | 'push' | 'sms' | 'slack')[];
}

export interface AgentPermission {
  resource: string;
  actions: ('create' | 'read' | 'update' | 'delete' | 'assign' | 'close')[];
}

export const helpdeskAgents = pgTable('helpdesk_agents', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // User Information
  userId: varchar('user_id', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  avatar: varchar('avatar', { length: 500 }),

  // Role & Department
  role: varchar('role', { length: 30 }).notNull().default('agent'),
  departmentId: varchar('department_id', { length: 30 }),
  teamIds: jsonb('team_ids').$type<string[]>(),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('active'),
  availability: varchar('availability', { length: 20 }).default('offline'),
  isOnline: boolean('is_online').default(false),
  lastSeenAt: timestamp('last_seen_at'),

  // Capacity
  maxActiveTickets: integer('max_active_tickets').default(10),
  currentActiveTickets: integer('current_active_tickets').default(0),

  // Skills
  skills: jsonb('skills').$type<string[]>(),
  languages: jsonb('languages').$type<string[]>(),
  expertise: jsonb('expertise').$type<string[]>(),

  // Permissions
  permissions: jsonb('permissions').$type<AgentPermission[]>(),
  canAccessAllTickets: boolean('can_access_all_tickets').default(false),
  canManageKnowledge: boolean('can_manage_knowledge').default(false),

  // Performance
  averageResponseTime: integer('average_response_time'), // minutes
  averageResolutionTime: integer('average_resolution_time'), // minutes
  satisfactionScore: numeric('satisfaction_score', { precision: 3, scale: 2 }),
  ticketsResolved: integer('tickets_resolved').default(0),
  ticketsAssigned: integer('tickets_assigned').default(0),

  // Working Hours
  workingHours: jsonb('working_hours').$type<WorkingHours>(),
  timezone: varchar('timezone', { length: 50 }),

  // Signature
  signature: text('signature'),

  // Notifications
  notificationPreferences: jsonb('notification_preferences').$type<NotificationPreferences>(),
}, (table) => [
  index('helpdesk_agents_user_idx').on(table.userId),
  index('helpdesk_agents_department_idx').on(table.departmentId),
  index('helpdesk_agents_status_idx').on(table.status),
  index('helpdesk_agents_availability_idx').on(table.availability),
  index('helpdesk_agents_email_idx').on(table.email),
]);

export type HelpdeskAgent = typeof helpdeskAgents.$inferSelect;
export type NewHelpdeskAgent = typeof helpdeskAgents.$inferInsert;
