import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { chatChannels } from './chat-channels';

// Call types
export type ChatCallType = 'voice' | 'video';
export type ChatCallStatus = 'ringing' | 'active' | 'ended' | 'missed' | 'declined' | 'failed';

// Participant shape stored in JSONB
export interface ChatCallParticipant {
  userId: string;
  userName: string;
  userAvatar?: string;
  joinedAt: string;
  leftAt?: string;
  cfSessionId: string;
  hasAudio: boolean;
  hasVideo: boolean;
  hasScreenShare: boolean;
}

export const chatCalls = pgTable('chat_calls', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Channel reference
  channelId: varchar('channel_id', { length: 30 }).notNull().references(() => chatChannels.id),

  // Call info
  callType: varchar('call_type', { length: 20 }).notNull().default('voice'),
  status: varchar('status', { length: 20 }).notNull().default('ringing'),

  // Cloudflare Realtime SFU
  cfAppId: varchar('cf_app_id', { length: 100 }),

  // Initiator
  initiatorId: varchar('initiator_id', { length: 255 }).notNull(),
  initiatorName: varchar('initiator_name', { length: 255 }).notNull(),

  // Participants (denormalized JSONB for fast reads)
  participants: jsonb('participants').$type<ChatCallParticipant[]>().default([]),

  // Timing
  startedAt: timestamp('started_at'),
  endedAt: timestamp('ended_at'),
  duration: integer('duration'),

  // System message references
  startMessageId: varchar('start_message_id', { length: 30 }),
  endMessageId: varchar('end_message_id', { length: 30 }),

  // Stats
  maxParticipants: integer('max_participants').notNull().default(0),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('chat_calls_channel_idx').on(table.channelId),
  index('chat_calls_status_idx').on(table.status),
  index('chat_calls_initiator_idx').on(table.initiatorId),
  index('chat_calls_created_at_idx').on(table.createdAt),
]);

export type ChatCall = typeof chatCalls.$inferSelect;
export type NewChatCall = typeof chatCalls.$inferInsert;
