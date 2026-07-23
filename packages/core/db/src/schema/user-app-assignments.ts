import { pgTable, varchar, boolean, timestamp, unique } from 'drizzle-orm/pg-core';

// User app assignments - tracks which apps a user has installed
export const userAppAssignments = pgTable(
  'user_app_assignments',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    userId: varchar('user_id', { length: 255 }).notNull(),
    appCode: varchar('app_code', { length: 50 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow(),
    grantedBy: varchar('granted_by', { length: 255 }),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('uq_user_app_assignment').on(table.userId, table.appCode),
  ]
);

export type UserAppAssignment = typeof userAppAssignments.$inferSelect;
export type NewUserAppAssignment = typeof userAppAssignments.$inferInsert;
