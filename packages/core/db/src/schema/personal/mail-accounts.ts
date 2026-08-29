import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  pgEnum,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const personalMailProviderEnum = pgEnum('personal_mail_provider', [
  'weldmail',
  'gmail',
  'outlook',
  'imap',
  'smtp',
  'custom',
]);

export const personalMailAccountStatusEnum = pgEnum('personal_mail_account_status', [
  'active',
  'inactive',
  'error',
  'suspended',
]);

export const personalMailAccounts = pgTable(
  'personal_mail_accounts',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    personalAccountId: varchar('personal_account_id', { length: 30 }).notNull(),

    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 255 }),

    provider: personalMailProviderEnum('provider').notNull().default('weldmail'),
    status: personalMailAccountStatusEnum('status').notNull().default('active'),

    signature: text('signature'),
    aiSettings: jsonb('ai_settings').$type<{
      customInstructions?: string;
      defaultTone?: 'professional' | 'friendly' | 'casual';
      defaultLength?: 'short' | 'medium' | 'long';
    }>(),

    dailySendLimit: integer('daily_send_limit'),
    sentToday: integer('sent_today').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('personal_mail_accounts_personal_account_id_idx').on(table.personalAccountId),
    uniqueIndex('personal_mail_accounts_email_idx').on(table.email),
    index('personal_mail_accounts_status_idx').on(table.status),
  ],
);

export type PersonalMailAccount = typeof personalMailAccounts.$inferSelect;
export type NewPersonalMailAccount = typeof personalMailAccounts.$inferInsert;
