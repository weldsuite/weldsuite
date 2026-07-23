import { pgTable, varchar, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// Private per-viewer notes about another team member.
// Each (authorUserId, subjectUserId) pair has at most one note row.
export const memberNotes = pgTable(
  'member_notes',
  {
    id: varchar('id', { length: 30 }).primaryKey(),

    authorUserId: varchar('author_user_id', { length: 255 }).notNull(),
    subjectUserId: varchar('subject_user_id', { length: 255 }).notNull(),

    body: text('body').notNull().default(''),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('member_notes_author_subject_unique').on(table.authorUserId, table.subjectUserId),
    index('member_notes_subject_idx').on(table.subjectUserId),
  ]
);

export type MemberNote = typeof memberNotes.$inferSelect;
export type NewMemberNote = typeof memberNotes.$inferInsert;
