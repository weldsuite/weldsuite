import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

// Signature type enum
export const mailSignatureTypeEnum = pgEnum('mail_signature_type', [
  'personal',
  'company',
  'department',
]);

// Signature position enum
export const mailSignaturePositionEnum = pgEnum('mail_signature_position', [
  'above',
  'below',
]);

// Mail Signatures table
export const mailSignatures = pgTable('mail_signatures', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Signature Information
  name: varchar('name', { length: 255 }).notNull(),
  content: text('content').notNull(), // HTML content

  // Default flag
  isDefault: boolean('is_default').notNull().default(false),

  // Assignment (which accounts/users can use this signature)
  accountIds: jsonb('account_ids').$type<string[]>(), // Assigned to specific accounts
  userIds: jsonb('user_ids').$type<string[]>(), // Assigned to specific users

  // Type
  type: mailSignatureTypeEnum('type').notNull().default('personal'),

  // Settings
  includeInReplies: boolean('include_in_replies').notNull().default(true),
  includeInForwards: boolean('include_in_forwards').notNull().default(true),
  position: mailSignaturePositionEnum('position').notNull().default('below'),

  // Metadata
  tags: jsonb('tags').$type<string[]>(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('mail_signatures_is_default_idx').on(table.isDefault),
  index('mail_signatures_type_idx').on(table.type),
]);

export type MailSignature = typeof mailSignatures.$inferSelect;
export type NewMailSignature = typeof mailSignatures.$inferInsert;
