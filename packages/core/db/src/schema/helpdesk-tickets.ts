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

// Ticket types
export type TicketStatus = 'new' | 'open' | 'pending' | 'on_hold' | 'in_progress' | 'resolved' | 'closed' | 'cancelled';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent' | 'critical';
export type TicketSeverity = 'minor' | 'major' | 'critical' | 'blocker';
export type TicketCategory = 'technical_support' | 'billing' | 'sales' | 'general_inquiry' | 'feature_request' | 'bug_report' | 'complaint' | 'other';
export type TicketChannel = 'email' | 'web' | 'phone' | 'chat' | 'social_media' | 'api' | 'mobile';
export type TicketType = 'question' | 'incident' | 'problem' | 'feature_request' | 'service_request';
export type SLAStatus = 'active' | 'warning' | 'breached' | 'achieved' | 'paused';

export interface TicketAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

export const helpdeskTickets = pgTable('helpdesk_tickets', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  ticketNumber: varchar('ticket_number', { length: 50 }).notNull(),
  reference: varchar('reference', { length: 100 }),

  // Customer Information
  contactId: varchar('contact_id', { length: 30 }),
  // Counterparty + person (new — populated by migration backfill).
  // For b2c tickets the migration creates a wrapping party for the person
  // so every ticket has a non-null counterparty after backfill.
  counterpartyId: varchar('counterparty_id', { length: 30 }),
  personId: varchar('person_id', { length: 30 }),
  customerName: varchar('customer_name', { length: 255 }).notNull(),
  customerEmail: varchar('customer_email', { length: 255 }).notNull(),
  customerPhone: varchar('customer_phone', { length: 50 }),
  customerCompany: varchar('customer_company', { length: 255 }),

  // Ticket Details
  subject: varchar('subject', { length: 500 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 50 }).notNull().default('general_inquiry'),
  subcategory: varchar('subcategory', { length: 100 }),

  // Status & Priority
  status: varchar('status', { length: 20 }).notNull().default('new'),
  priority: varchar('priority', { length: 20 }).notNull().default('medium'),
  severity: varchar('severity', { length: 20 }),

  // Assignment
  assigneeId: varchar('assignee_id', { length: 30 }),
  assigneeName: varchar('assignee_name', { length: 255 }),
  departmentId: varchar('department_id', { length: 30 }),
  teamId: varchar('team_id', { length: 30 }),

  // Channel
  channel: varchar('channel', { length: 20 }).notNull().default('web'),
  sourceEmail: varchar('source_email', { length: 255 }),
  sourceUrl: varchar('source_url', { length: 500 }),

  // Type
  type: varchar('type', { length: 30 }).notNull().default('question'),
  ticketTypeId: varchar('ticket_type_id', { length: 30 }),
  issueType: varchar('issue_type', { length: 50 }),

  // SLA
  slaId: varchar('sla_id', { length: 30 }),
  responseDeadline: timestamp('response_deadline'),
  resolutionDeadline: timestamp('resolution_deadline'),
  slaStatus: varchar('sla_status', { length: 20 }),
  breachedAt: timestamp('breached_at'),

  // Timing
  firstResponseAt: timestamp('first_response_at'),
  resolvedAt: timestamp('resolved_at'),
  closedAt: timestamp('closed_at'),
  reopenedAt: timestamp('reopened_at'),
  responseTime: integer('response_time'), // minutes
  resolutionTime: integer('resolution_time'), // minutes

  // Product/Service
  productId: varchar('product_id', { length: 30 }),
  productName: varchar('product_name', { length: 255 }),
  version: integer('version'),
  environment: varchar('environment', { length: 50 }),

  // Message counts
  messageCount: integer('message_count').default(0),
  lastMessageAt: timestamp('last_message_at'),
  lastCustomerMessageAt: timestamp('last_customer_message_at'),
  lastAgentMessageAt: timestamp('last_agent_message_at'),

  // Satisfaction
  satisfactionRating: integer('satisfaction_rating'),
  satisfactionComment: text('satisfaction_comment'),
  satisfactionSurveyId: varchar('satisfaction_survey_id', { length: 30 }),

  // Tags & Custom fields
  tags: jsonb('tags').$type<string[]>(),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),

  // Related tickets
  parentTicketId: varchar('parent_ticket_id', { length: 30 }),
  childTicketIds: jsonb('child_ticket_ids').$type<string[]>(),
  relatedTicketIds: jsonb('related_ticket_ids').$type<string[]>(),
  mergedTicketIds: jsonb('merged_ticket_ids').$type<string[]>(),

  // Flags
  isEscalated: boolean('is_escalated').default(false),
  isSpam: boolean('is_spam').default(false),
  isPublic: boolean('is_public').default(true),
  requiresApproval: boolean('requires_approval').default(false),

  // Attachments
  attachments: jsonb('attachments').$type<TicketAttachment[]>(),
  attachmentCount: integer('attachment_count').default(0),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('helpdesk_tickets_contact_id_idx').on(table.contactId),
  index('helpdesk_tickets_counterparty_idx').on(table.counterpartyId),
  index('helpdesk_tickets_person_idx').on(table.personId),
  index('helpdesk_tickets_customer_email_idx').on(table.customerEmail),
  index('helpdesk_tickets_status_idx').on(table.status),
  index('helpdesk_tickets_priority_idx').on(table.priority),
  index('helpdesk_tickets_category_idx').on(table.category),
  index('helpdesk_tickets_assignee_idx').on(table.assigneeId),
  index('helpdesk_tickets_department_idx').on(table.departmentId),
  index('helpdesk_tickets_channel_idx').on(table.channel),
  index('helpdesk_tickets_sla_status_idx').on(table.slaStatus),
  index('helpdesk_tickets_number_idx').on(table.ticketNumber),
  index('helpdesk_tickets_created_at_idx').on(table.createdAt),
]);

export type HelpdeskTicket = typeof helpdeskTickets.$inferSelect;
export type NewHelpdeskTicket = typeof helpdeskTickets.$inferInsert;
