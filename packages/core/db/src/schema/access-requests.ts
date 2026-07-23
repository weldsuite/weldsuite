import { pgTable, varchar, timestamp, index } from 'drizzle-orm/pg-core';

export const accessRequests = pgTable(
  'access_requests',
  {
    id: varchar('id', { length: 30 }).primaryKey(),

    requesterId: varchar('requester_id', { length: 255 }).notNull(),

    permission: varchar('permission', { length: 100 }).notNull(),
    pageLabel: varchar('page_label', { length: 120 }),
    pagePath: varchar('page_path', { length: 255 }),

    // 'pending' | 'approved' | 'denied'
    status: varchar('status', { length: 20 }).notNull().default('pending'),

    resolvedBy: varchar('resolved_by', { length: 255 }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('access_requests_status_idx').on(table.status),
    index('access_requests_requester_perm_status_idx').on(
      table.requesterId,
      table.permission,
      table.status,
    ),
  ],
);

export type AccessRequest = typeof accessRequests.$inferSelect;
export type NewAccessRequest = typeof accessRequests.$inferInsert;
