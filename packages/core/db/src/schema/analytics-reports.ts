import {
  pgTable,
  varchar,
  timestamp,
  integer,
  text,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Generic analytics reports table
 * Supports multiple apps (helpdesk, crm, projects, etc.) via the `app` column
 */
export const analyticsReports = pgTable('analytics_reports', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // App identifier - which module this report belongs to
  app: varchar('app', { length: 50 }).notNull(), // 'helpdesk' | 'crm' | 'projects' | etc.

  // Report metadata
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),

  // Creator tracking
  createdById: varchar('created_by_id', { length: 255 }),

  // Chart count (denormalized for list view performance)
  chartCount: integer('chart_count').notNull().default(0),
}, (table) => [
  index('analytics_reports_app_idx').on(table.app),
]);

// App type for type safety
export type AnalyticsApp = 'helpdesk' | 'crm' | 'projects';

export type AnalyticsReport = typeof analyticsReports.$inferSelect;
export type NewAnalyticsReport = typeof analyticsReports.$inferInsert;
