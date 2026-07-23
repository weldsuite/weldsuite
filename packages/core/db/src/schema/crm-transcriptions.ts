import {
  pgTable,
  varchar,
  timestamp,
  integer,
  text,
  real,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Word-level timing data from transcription provider
 */
export interface TranscriptWordTiming {
  text: string;
  start: number; // seconds
  end: number; // seconds
  confidence: number;
}

/**
 * Transcription status enum values
 */
export const TRANSCRIPTION_STATUS = ['pending', 'processing', 'completed', 'failed'] as const;
export type TranscriptionStatus = (typeof TRANSCRIPTION_STATUS)[number];

/**
 * Transcription record for call recordings
 */
export const crmTranscriptions = pgTable('crm_transcriptions', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Link to activity
  activityId: varchar('activity_id', { length: 30 }).notNull(),

  // Transcription status
  status: varchar('status', { length: 20 }).notNull().default('pending'), // pending, processing, completed, failed

  // Full transcription text
  fullText: text('full_text'),

  // AI model info
  model: varchar('model', { length: 100 }), // e.g., "gpt-4o-transcribe-diarize"
  provider: varchar('provider', { length: 50 }), // e.g., "openai"
  language: varchar('language', { length: 10 }).default('en'),

  // Statistics
  speakerCount: integer('speaker_count'),
  wordCount: integer('word_count'),
  confidence: real('confidence'), // 0.0 - 1.0

  // Error handling
  errorMessage: text('error_message'),

  // Timing
  processingStartedAt: timestamp('processing_started_at'),
  processingCompletedAt: timestamp('processing_completed_at'),

  // Additional metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(), // Additional provider-specific data
}, (table) => [
  index('crm_transcriptions_activity_idx').on(table.activityId),
  index('crm_transcriptions_status_idx').on(table.status),
]);

/**
 * Individual transcript segments with speaker identification
 */
export const crmTranscriptSegments = pgTable('crm_transcript_segments', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // Link to transcription
  transcriptionId: varchar('transcription_id', { length: 30 }).notNull(),

  // Speaker info
  speakerId: integer('speaker_id').notNull(), // 0, 1, 2, etc.
  speakerLabel: varchar('speaker_label', { length: 50 }), // "Speaker 1", "Speaker 2"
  speakerName: varchar('speaker_name', { length: 255 }), // Optional identified name

  // Segment content
  text: text('text').notNull(),

  // Timing
  startTime: real('start_time').notNull(), // seconds
  endTime: real('end_time').notNull(), // seconds
  timestamp: varchar('timestamp', { length: 20 }), // "00:01:23" format

  // Quality
  confidence: real('confidence'), // segment-level confidence

  // Word-level timing data
  words: jsonb('words').$type<TranscriptWordTiming[] | null>(),

  // Ordering
  sequenceNumber: integer('sequence_number').notNull(),
}, (table) => [
  index('crm_transcript_segments_transcription_idx').on(table.transcriptionId),
  index('crm_transcript_segments_speaker_idx').on(table.speakerId),
]);

export type CrmTranscription = typeof crmTranscriptions.$inferSelect;
export type NewCrmTranscription = typeof crmTranscriptions.$inferInsert;
export type CrmTranscriptSegment = typeof crmTranscriptSegments.$inferSelect;
export type NewCrmTranscriptSegment = typeof crmTranscriptSegments.$inferInsert;
