import {
  pgTable,
  varchar,
  timestamp,
  integer,
  index,
  jsonb,
  text,
  boolean,
} from 'drizzle-orm/pg-core';
import { mailAccounts } from './mail-accounts';

// Mail Labels table
export const mailLabels = pgTable('mail_labels', {
  id: varchar('id', { length: 30 }).primaryKey(),
  accountId: varchar('account_id', { length: 30 }).notNull().references(() => mailAccounts.id),

  // Label Information
  name: varchar('name', { length: 100 }).notNull(),
  color: varchar('color', { length: 7 }), // Hex color code like #FF5733

  // System label support
  isSystem: boolean('is_system').default(false),
  slug: varchar('slug', { length: 50 }), // 'INBOX', 'SENT', etc. for system labels

  // Count
  messageCount: integer('message_count').notNull().default(0),

  // Position for ordering
  position: integer('position').default(0),

  // AI Auto-Labeling Configuration
  aiEnabled: boolean('ai_enabled').default(false),
  aiKeywords: jsonb('ai_keywords').$type<string[]>(),
  aiDescription: text('ai_description'),
  aiConfidence: integer('ai_confidence').default(70), // Minimum confidence threshold (0-100)

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('mail_labels_account_id_idx').on(table.accountId),
  index('mail_labels_name_idx').on(table.name),
]);

export type MailLabel = typeof mailLabels.$inferSelect;
export type NewMailLabel = typeof mailLabels.$inferInsert;
