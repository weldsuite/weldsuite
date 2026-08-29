import {
  pgTable,
  varchar,
  timestamp,
  integer,
  index,
  text,
  boolean,
} from 'drizzle-orm/pg-core';
import { personalMailAccounts } from './mail-accounts';

export const personalMailLabels = pgTable(
  'personal_mail_labels',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    personalAccountId: varchar('personal_account_id', { length: 30 }).notNull(),
    accountId: varchar('account_id', { length: 30 })
      .notNull()
      .references(() => personalMailAccounts.id),

    name: varchar('name', { length: 100 }).notNull(),
    color: varchar('color', { length: 7 }),
    isSystem: boolean('is_system').default(false),
    slug: varchar('slug', { length: 50 }),
    messageCount: integer('message_count').notNull().default(0),
    position: integer('position').default(0),
    aiDescription: text('ai_description'),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('personal_mail_labels_personal_account_id_idx').on(table.personalAccountId),
    index('personal_mail_labels_account_id_idx').on(table.accountId),
  ],
);

export type PersonalMailLabel = typeof personalMailLabels.$inferSelect;
export type NewPersonalMailLabel = typeof personalMailLabels.$inferInsert;
