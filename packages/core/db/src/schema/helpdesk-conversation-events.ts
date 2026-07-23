import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';
import { helpdeskConversations } from './helpdesk-conversations';

// ============================================================================
// Event Type Taxonomy — domain.action pattern
// ============================================================================

export type ConversationEventType =
  // Lifecycle
  | 'conversation.created'
  | 'conversation.reopened'
  | 'conversation.closed'
  | 'conversation.archived'
  | 'conversation.unarchived'
  | 'conversation.deleted'
  | 'conversation.merged'
  | 'conversation.split'
  | 'conversation.snoozed'
  | 'conversation.unsnoozed'
  // Assignment
  | 'assignment.agent_assigned'
  | 'assignment.agent_unassigned'
  | 'assignment.department_transferred'
  | 'assignment.auto_assigned'
  // Status & Priority
  | 'status.changed'
  | 'priority.changed'
  // Ticket (when conversation is promoted to ticket)
  | 'ticket.promoted'
  | 'ticket.linked'
  | 'ticket.unlinked'
  // SLA
  | 'sla.applied'
  | 'sla.warning'
  | 'sla.breached'
  | 'sla.achieved'
  | 'sla.paused'
  | 'sla.resumed'
  // Tags & Labels
  | 'tag.added'
  | 'tag.removed'
  | 'label.added'
  | 'label.removed'
  // Customer
  | 'customer.info_updated'
  | 'customer.contact_linked'
  | 'customer.contact_unlinked'
  // Escalation
  | 'escalation.escalated'
  | 'escalation.deescalated'
  // Channel
  | 'channel.email_sent'
  | 'channel.email_received'
  | 'channel.email_bounced'
  // Notes
  | 'note.added'
  // Satisfaction
  | 'satisfaction.survey_sent'
  | 'satisfaction.rating_received'
  // AI / Automation
  | 'automation.workflow_triggered'
  | 'automation.ai_response'
  | 'automation.ai_handoff'
  // Spam
  | 'spam.marked'
  | 'spam.unmarked'
  // Custom (escape hatch for integrations)
  | 'custom.event';

export type EventInitiator = 'agent' | 'customer' | 'system' | 'automation' | 'ai';

// ============================================================================
// Typed Event Data Payloads
// ============================================================================

export interface AssignmentEventData {
  fromAgentId?: string | null;
  fromAgentName?: string | null;
  toAgentId?: string | null;
  toAgentName?: string | null;
  toAgentAvatar?: string | null;
  reason?: string;
}

export interface DepartmentTransferEventData {
  fromDepartmentId?: string | null;
  fromDepartmentName?: string | null;
  toDepartmentId: string;
  toDepartmentName?: string;
  assigneeCleared?: boolean;
}

export interface StatusChangeEventData {
  from: string;
  to: string;
  reason?: string;
  resolution?: string;
}

export interface PriorityChangeEventData {
  from: string | null;
  to: string;
}

export interface SlaEventData {
  slaId: string;
  slaName?: string;
  metric?: 'first_response' | 'resolution' | 'update';
  targetMinutes?: number;
  elapsedMinutes?: number;
  breachedAt?: string;
}

export interface TagEventData {
  tag: string;
  allTags?: string[];
}

export interface CustomerEventData {
  contactId?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  changedFields?: Record<string, { from: unknown; to: unknown }>;
}

export interface EscalationEventData {
  fromAgentId?: string;
  fromAgentName?: string;
  toAgentId?: string;
  toAgentName?: string;
  toDepartmentId?: string;
  toDepartmentName?: string;
  reason?: string;
  previousPriority?: string;
  newPriority?: string;
}

export interface TicketEventData {
  ticketNumber?: string;
  ticketSubject?: string;
}

export interface MergeEventData {
  sourceConversationId: string;
  sourceConversationNumber?: string;
  targetConversationId: string;
  targetConversationNumber?: string;
  messagesMoved?: number;
}

export interface NoteEventData {
  noteContent?: string;
  isImportant?: boolean;
}

export interface SatisfactionEventData {
  surveyId?: string;
  rating?: number;
  comment?: string;
}

export interface AutomationEventData {
  workflowId?: string;
  workflowName?: string;
  stepId?: string;
  stepType?: string;
  result?: string;
}

export interface SnoozeEventData {
  snoozedUntil?: string;
  reason?: string;
}

export type ConversationEventData =
  | AssignmentEventData
  | DepartmentTransferEventData
  | StatusChangeEventData
  | PriorityChangeEventData
  | SlaEventData
  | TagEventData
  | CustomerEventData
  | EscalationEventData
  | TicketEventData
  | MergeEventData
  | NoteEventData
  | SatisfactionEventData
  | AutomationEventData
  | SnoozeEventData
  | Record<string, unknown>;

// ============================================================================
// Table Definition
// ============================================================================

export const helpdeskConversationEvents = pgTable('helpdesk_conversation_events', {
  id: varchar('id', { length: 30 }).primaryKey(),
  conversationId: varchar('conversation_id', { length: 30 })
    .notNull()
    .references(() => helpdeskConversations.id),

  // Event classification
  eventType: varchar('event_type', { length: 60 }).notNull(),
  initiator: varchar('initiator', { length: 20 }).notNull().default('system'),
  actorId: varchar('actor_id', { length: 255 }),
  actorName: varchar('actor_name', { length: 255 }),
  actorAvatar: varchar('actor_avatar', { length: 500 }),

  // Human-readable description for timeline rendering
  description: text('description').notNull(),

  // Structured event payload (typed per event_type)
  data: jsonb('data').$type<ConversationEventData>(),

  // For field-change events: before/after diff
  changes: jsonb('changes').$type<Record<string, { from: unknown; to: unknown }>>(),

  // Whether this event is visible to the customer (in widget timeline)
  isPublic: boolean('is_public').notNull().default(false),

  createdAt: timestamp('created_at').notNull().defaultNow(),

  // Optional: link to the message that triggered this event
  relatedMessageId: varchar('related_message_id', { length: 30 }),

  // Optional: link to external entity (e.g., SLA ID, workflow ID)
  relatedEntityType: varchar('related_entity_type', { length: 50 }),
  relatedEntityId: varchar('related_entity_id', { length: 30 }),

  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('hd_conv_events_conversation_created_idx').on(table.conversationId, table.createdAt),
  index('hd_conv_events_conversation_type_idx').on(table.conversationId, table.eventType),
  index('hd_conv_events_type_created_idx').on(table.eventType, table.createdAt),
  index('hd_conv_events_actor_idx').on(table.actorId),
  index('hd_conv_events_public_idx').on(table.conversationId, table.isPublic, table.createdAt),
]);

export type HelpdeskConversationEvent = typeof helpdeskConversationEvents.$inferSelect;
export type NewHelpdeskConversationEvent = typeof helpdeskConversationEvents.$inferInsert;
