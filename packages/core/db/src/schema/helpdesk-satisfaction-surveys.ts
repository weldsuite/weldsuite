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

// Survey types
export type SurveyStatus = 'pending' | 'completed' | 'expired';

export interface SurveyResponse {
  questionId: string;
  question: string;
  type: 'rating' | 'text' | 'choice';
  answer: unknown;
}

export const helpdeskSatisfactionSurveys = pgTable('helpdesk_satisfaction_surveys', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Related entities
  ticketId: varchar('ticket_id', { length: 30 }).notNull(),
  customerId: varchar('customer_id', { length: 30 }).notNull(),
  // New counterparty FK — populated by migration backfill.
  counterpartyId: varchar('counterparty_id', { length: 30 }),

  // Rating
  rating: integer('rating'), // 1-5 or 1-10
  comment: text('comment'),

  // Questions
  responses: jsonb('responses').$type<SurveyResponse[]>(),

  // Timing
  sentAt: timestamp('sent_at').notNull(),
  respondedAt: timestamp('responded_at'),
  expiresAt: timestamp('expires_at'),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('pending'),

  // Follow-up
  followUpRequired: boolean('follow_up_required').default(false),
  followUpNotes: text('follow_up_notes'),
}, (table) => [
  index('helpdesk_satisfaction_surveys_ticket_idx').on(table.ticketId),
  index('helpdesk_satisfaction_surveys_customer_idx').on(table.customerId),
  index('helpdesk_satisfaction_surveys_counterparty_idx').on(table.counterpartyId),
  index('helpdesk_satisfaction_surveys_status_idx').on(table.status),
  index('helpdesk_satisfaction_surveys_rating_idx').on(table.rating),
  index('helpdesk_satisfaction_surveys_sent_at_idx').on(table.sentAt),
]);

export type HelpdeskSatisfactionSurvey = typeof helpdeskSatisfactionSurveys.$inferSelect;
export type NewHelpdeskSatisfactionSurvey = typeof helpdeskSatisfactionSurveys.$inferInsert;
