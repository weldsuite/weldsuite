import {
  pgTable,
  varchar,
  timestamp,
  text,
  index,
} from 'drizzle-orm/pg-core';
import { chatChannels } from './chat-channels';
import { chatMessages } from './chat-messages';

export const chatReminders = pgTable('chat_reminders', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // Who set the reminder
  userId: varchar('user_id', { length: 255 }).notNull(),

  // What message to remind about
  channelId: varchar('channel_id', { length: 30 }).notNull().references(() => chatChannels.id),
  messageId: varchar('message_id', { length: 30 }).notNull().references(() => chatMessages.id),
  messagePreview: text('message_preview'),

  // When to fire
  remindAt: timestamp('remind_at').notNull(),

  // When it was fired (null = pending)
  firedAt: timestamp('fired_at'),
}, (table) => [
  index('chat_reminders_user_idx').on(table.userId),
  index('chat_reminders_remind_at_idx').on(table.remindAt),
]);

export type ChatReminder = typeof chatReminders.$inferSelect;
export type NewChatReminder = typeof chatReminders.$inferInsert;
