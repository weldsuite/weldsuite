import {
  pgTable,
  varchar,
  timestamp,
  integer,
  text,
  boolean,
  index,
  jsonb,
  numeric,
} from 'drizzle-orm/pg-core';

/**
 * VoIP provider enum values
 */
export const VOIP_PROVIDERS = ['telnyx'] as const;
export type VoipProvider = (typeof VOIP_PROVIDERS)[number];

/**
 * VoIP call direction enum values
 */
export const VOIP_CALL_DIRECTIONS = ['inbound', 'outbound'] as const;
export type VoipCallDirection = (typeof VOIP_CALL_DIRECTIONS)[number];

/**
 * VoIP call status enum values
 */
export const VOIP_CALL_STATUSES = [
  'initiated',     // Call has been initiated
  'ringing',       // Call is ringing
  'answered',      // Call was answered
  'bridged',       // Call is connected
  'recording',     // Call is being recorded
  'on_hold',       // Call is on hold
  'completed',     // Call completed successfully
  'failed',        // Call failed
  'busy',          // Busy signal
  'no_answer',     // No answer
  'canceled',      // Call was canceled
] as const;
export type VoipCallStatus = (typeof VOIP_CALL_STATUSES)[number];

/**
 * AI sentiment values
 */
export const AI_SENTIMENT_VALUES = ['positive', 'neutral', 'negative', 'mixed'] as const;
export type AiSentiment = (typeof AI_SENTIMENT_VALUES)[number];

/**
 * VoIP calls table - tracks VoIP calls made through Telnyx
 */
export const voipCalls = pgTable('voip_calls', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // User who initiated/received the call
  userId: varchar('user_id', { length: 255 }).notNull(),

  // VoIP provider
  provider: varchar('provider', { length: 20 }).notNull().default('telnyx'),

  // Provider-specific identifiers
  providerCallId: varchar('provider_call_id', { length: 255 }), // Telnyx: call_control_id
  providerSessionId: varchar('provider_session_id', { length: 255 }), // Telnyx: call_session_id
  providerLegId: varchar('provider_leg_id', { length: 255 }), // Telnyx: call_leg_id

  // Call details
  direction: varchar('direction', { length: 20 }).notNull(), // inbound/outbound
  status: varchar('status', { length: 20 }).notNull().default('initiated'),

  // Phone numbers
  fromNumber: varchar('from_number', { length: 50 }).notNull(),
  toNumber: varchar('to_number', { length: 50 }).notNull(),
  fromNumberFormatted: varchar('from_number_formatted', { length: 50 }),
  toNumberFormatted: varchar('to_number_formatted', { length: 50 }),

  // Timing
  initiatedAt: timestamp('initiated_at').notNull().defaultNow(),
  answeredAt: timestamp('answered_at'),
  endedAt: timestamp('ended_at'),
  duration: integer('duration'), // Duration in seconds

  // Recording
  isRecorded: boolean('is_recorded').default(false),
  recordingStorageKey: varchar('recording_storage_key', { length: 500 }),
  recordingStorageUrl: text('recording_storage_url'),
  recordingFileSize: integer('recording_file_size'),
  recordingDuration: integer('recording_duration'), // Duration in seconds
  recordingSid: varchar('recording_sid', { length: 255 }), // Provider recording ID

  // Transcription
  transcriptionId: varchar('transcription_id', { length: 30 }),
  transcriptionStatus: varchar('transcription_status', { length: 20 }),

  // CRM linking
  customerId: varchar('customer_id', { length: 30 }),
  contactId: varchar('contact_id', { length: 30 }),
  opportunityId: varchar('opportunity_id', { length: 30 }),
  activityId: varchar('activity_id', { length: 30 }), // Link to CRM activity

  // Credits
  creditsConsumed: integer('credits_consumed').default(0),
  creditTransactionId: varchar('credit_transaction_id', { length: 30 }),

  // AI Analysis
  aiSummary: text('ai_summary'),
  aiSentiment: varchar('ai_sentiment', { length: 20 }), // positive, neutral, negative, mixed
  aiKeyTopics: jsonb('ai_key_topics').$type<string[]>(),
  aiActionItems: jsonb('ai_action_items').$type<string[]>(),
  aiAnalyzedAt: timestamp('ai_analyzed_at'),

  // Call metadata
  hangupCause: varchar('hangup_cause', { length: 100 }),
  hangupSource: varchar('hangup_source', { length: 50 }),
  errorMessage: text('error_message'),

  // Call quality metrics
  callQualityScore: numeric('call_quality_score', { precision: 3, scale: 2 }),

  // Notes
  notes: text('notes'),
}, (table) => [
  index('voip_calls_user_idx').on(table.userId),
  index('voip_calls_status_idx').on(table.status),
  index('voip_calls_direction_idx').on(table.direction),
  index('voip_calls_from_number_idx').on(table.fromNumber),
  index('voip_calls_to_number_idx').on(table.toNumber),
  index('voip_calls_customer_idx').on(table.customerId),
  index('voip_calls_contact_idx').on(table.contactId),
  index('voip_calls_opportunity_idx').on(table.opportunityId),
  index('voip_calls_provider_call_idx').on(table.providerCallId),
  index('voip_calls_initiated_at_idx').on(table.initiatedAt),
  index('voip_calls_provider_idx').on(table.provider),
]);

export type VoipCall = typeof voipCalls.$inferSelect;
export type NewVoipCall = typeof voipCalls.$inferInsert;

