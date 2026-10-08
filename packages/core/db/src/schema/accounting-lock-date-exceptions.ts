import {
  pgTable,
  varchar,
  timestamp,
  text,
  index,
} from 'drizzle-orm/pg-core';

/**
 * A time-limited exception to one of an entity's lock dates (sales, purchase,
 * tax or period). The hard lock never has exceptions.
 *
 * `userId` null means the exception applies to every member. Exceptions are
 * never deleted: revoking one stamps `revokedAt`, so the trail of who was
 * allowed to post into a locked period, when and why, stays complete.
 */
export const lockDateExceptions = pgTable('lock_date_exceptions', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  /** sales | purchase | tax | period */
  lockType: varchar('lock_type', { length: 10 }).notNull(),
  userId: varchar('user_id', { length: 255 }),
  endsAt: timestamp('ends_at').notNull(),
  reason: text('reason').notNull(),
  createdBy: varchar('created_by', { length: 255 }),
  revokedAt: timestamp('revoked_at'),
  revokedBy: varchar('revoked_by', { length: 255 }),
}, (table) => [
  index('acct_lock_date_exceptions_entity_idx').on(table.entityId),
]);

export type LockDateException = typeof lockDateExceptions.$inferSelect;
export type NewLockDateException = typeof lockDateExceptions.$inferInsert;
