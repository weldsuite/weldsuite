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

// Conversation types (includes ticket statuses since tickets are conversations with isTicket=true)
export type ConversationStatus =
  | 'active' | 'pending' | 'resolved' | 'closed' | 'archived' | 'snoozed'
  | 'new' | 'open' | 'on_hold' | 'in_progress' | 'cancelled';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent' | 'critical';
export type TicketSeverity = 'minor' | 'major' | 'critical' | 'blocker';
export type TicketChannel = 'email' | 'web' | 'phone' | 'chat' | 'social_media' | 'api' | 'mobile';
export type TicketType = 'question' | 'incident' | 'problem' | 'feature_request' | 'service_request';
export type SLAStatus = 'active' | 'warning' | 'breached' | 'achieved' | 'paused';

export const helpdeskConversations = pgTable('helpdesk_conversations', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  conversationNumber: varchar('conversation_number', { length: 50 }).notNull(),
  reference: varchar('reference', { length: 100 }),

  // Customer Information
  contactId: varchar('contact_id', { length: 30 }),
  // Counterparty + person (new — populated by migration backfill).
  counterpartyId: varchar('counterparty_id', { length: 30 }),
  personId: varchar('person_id', { length: 30 }),
  customerName: varchar('customer_name', { length: 255 }).notNull(),
  customerEmail: varchar('customer_email', { length: 255 }),
  customerPhone: varchar('customer_phone', { length: 50 }),
  customerCompany: varchar('customer_company', { length: 255 }),
  customerAvatar: varchar('customer_avatar', { length: 500 }),

  // Conversation Details
  subject: varchar('subject', { length: 500 }).notNull(),
  preview: text('preview'),
  lastMessage: text('last_message'),

  // Status & Priority
  status: varchar('status', { length: 20 }).notNull().default('active'),
  priority: varchar('priority', { length: 20 }),

  // Assignment
  assigneeId: varchar('assignee_id', { length: 255 }),
  assigneeName: varchar('assignee_name', { length: 255 }),
  assigneeAvatar: varchar('assignee_avatar', { length: 500 }),
  departmentId: varchar('department_id', { length: 30 }),

  // Channel
  channel: varchar('channel', { length: 20 }).notNull().default('web'),
  source: varchar('source', { length: 100 }),

  // Message counts
  messageCount: integer('message_count').notNull().default(0),
  unreadCount: integer('unread_count').default(0),
  lastMessageAt: timestamp('last_message_at'),
  lastCustomerMessageAt: timestamp('last_customer_message_at'),
  lastAgentMessageAt: timestamp('last_agent_message_at'),

  // Ticket promotion (null ticketNumber = plain conversation)
  ticketNumber: varchar('ticket_number', { length: 50 }),
  isTicket: boolean('is_ticket').notNull().default(false),

  // Category & Type (ticket-specific, nullable for plain conversations)
  category: varchar('category', { length: 50 }),
  subcategory: varchar('subcategory', { length: 100 }),
  ticketType: varchar('ticket_type', { length: 30 }),
  ticketTypeId: varchar('ticket_type_id', { length: 30 }),

  // Severity (separate from priority)
  severity: varchar('severity', { length: 20 }),

  // SLA
  slaId: varchar('sla_id', { length: 30 }),
  responseDeadline: timestamp('response_deadline'),
  resolutionDeadline: timestamp('resolution_deadline'),
  slaStatus: varchar('sla_status', { length: 20 }),
  breachedAt: timestamp('breached_at'),

  // Timing metrics
  firstResponseAt: timestamp('first_response_at'),
  resolvedAt: timestamp('resolved_at'),
  closedAt: timestamp('closed_at'),
  reopenedAt: timestamp('reopened_at'),
  responseTime: integer('response_time'),
  resolutionTime: integer('resolution_time'),

  // Satisfaction
  satisfactionRating: integer('satisfaction_rating'),
  satisfactionComment: text('satisfaction_comment'),

  // Custom fields (tenant-defined)
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),

  // Related conversations
  relatedConversationIds: jsonb('related_conversation_ids').$type<string[]>(),
  parentConversationId: varchar('parent_conversation_id', { length: 30 }),
  mergedConversationIds: jsonb('merged_conversation_ids').$type<string[]>(),

  // Flags
  isRead: boolean('is_read').notNull().default(false),
  isStarred: boolean('is_starred').notNull().default(false),
  isArchived: boolean('is_archived').notNull().default(false),
  isSpam: boolean('is_spam').default(false),
  isEscalated: boolean('is_escalated').notNull().default(false),
  hasActiveWorkflow: boolean('has_active_workflow').notNull().default(false),

  // Tags & Labels
  tags: jsonb('tags').$type<string[]>(),
  labels: jsonb('labels').$type<string[]>(),

  // Attachments
  hasAttachments: boolean('has_attachments').notNull().default(false),
  attachmentCount: integer('attachment_count').default(0),

  // Snooze
  snoozedUntil: timestamp('snoozed_until'),

  // Email source
  sourceEmail: varchar('source_email', { length: 255 }),
  sourceUrl: varchar('source_url', { length: 500 }),

  // Visitor geolocation (captured from Cloudflare cf headers)
  visitorLocation: jsonb('visitor_location').$type<{
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
  }>(),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('helpdesk_conversations_contact_id_idx').on(table.contactId),
  index('helpdesk_conversations_counterparty_idx').on(table.counterpartyId),
  index('helpdesk_conversations_person_idx').on(table.personId),
  index('helpdesk_conversations_customer_email_idx').on(table.customerEmail),
  index('helpdesk_conversations_status_idx').on(table.status),
  index('helpdesk_conversations_assignee_idx').on(table.assigneeId),
  index('helpdesk_conversations_department_idx').on(table.departmentId),
  index('helpdesk_conversations_channel_idx').on(table.channel),
  index('helpdesk_conversations_is_read_idx').on(table.isRead),
  index('helpdesk_conversations_is_archived_idx').on(table.isArchived),
  index('helpdesk_conversations_last_message_idx').on(table.lastMessageAt),
  index('helpdesk_conversations_number_idx').on(table.conversationNumber),
  index('helpdesk_conversations_is_ticket_idx').on(table.isTicket),
  index('helpdesk_conversations_ticket_number_idx').on(table.ticketNumber),
  index('helpdesk_conversations_sla_status_idx').on(table.slaStatus),
  index('helpdesk_conversations_category_idx').on(table.category),
  index('helpdesk_conversations_created_at_idx').on(table.createdAt),
  index('helpdesk_conversations_status_created_idx').on(table.status, table.createdAt),
  index('helpdesk_conversations_assignee_status_idx').on(table.assigneeId, table.status),
]);

export type HelpdeskConversation = typeof helpdeskConversations.$inferSelect;
export type NewHelpdeskConversation = typeof helpdeskConversations.$inferInsert;
