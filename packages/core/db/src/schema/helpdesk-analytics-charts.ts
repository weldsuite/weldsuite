import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { helpdeskAnalyticsReports } from './helpdesk-analytics-reports';

// Chart type options
export type ChartType =
  | 'area-chart'
  | 'area-linear'
  | 'area-stacked'
  | 'bar-multiple'
  | 'bar-mixed'
  | 'bar-stacked'
  | 'bar-negative'
  | 'pie-label'
  | 'pie-donut'
  | 'radar-lines'
  | 'radial-simple'
  | 'radial-text';

// Entity types for helpdesk analytics
export type EntityType =
  | 'tickets'
  | 'conversations'
  | 'customers'
  | 'agents'
  | 'response_time'
  | 'satisfaction';

// Layout interface (react-grid-layout compatible)
export interface ChartLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

export const helpdeskAnalyticsCharts = pgTable('helpdesk_analytics_charts', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Report reference
  reportId: varchar('report_id', { length: 30 })
    .notNull()
    .references(() => helpdeskAnalyticsReports.id),

  // Chart metadata
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),

  // Chart configuration
  chartType: varchar('chart_type', { length: 50 }).notNull(),
  entity: varchar('entity', { length: 50 }).notNull(),
  metric: varchar('metric', { length: 100 }).notNull(),

  // Styling options
  color: varchar('color', { length: 20 }).notNull().default('#3b82f6'),
  smoothCurve: boolean('smooth_curve').notNull().default(true),
  fillArea: boolean('fill_area').notNull().default(true),
  showDataLabels: boolean('show_data_labels').notNull().default(false),
  showLegend: boolean('show_legend').notNull().default(true),

  // Query configuration
  timeRange: varchar('time_range', { length: 50 }).default('last_30_days'),
  groupBy: varchar('group_by', { length: 50 }).default('day'),
  aggregation: varchar('aggregation', { length: 50 }).default('sum'),
  sortOrder: varchar('sort_order', { length: 10 }).default('asc'),
  limit: integer('limit'),

  // Compare with previous period
  compareWith: varchar('compare_with', { length: 50 }),

  // Layout position (stored as JSONB for flexibility)
  layout: jsonb('layout').$type<ChartLayout>().notNull(),

  // Sort order within report (for deterministic ordering)
  sortIndex: integer('sort_index').notNull().default(0),
}, (table) => [
  index('helpdesk_analytics_charts_report_idx').on(table.reportId),
]);

export type HelpdeskAnalyticsChart = typeof helpdeskAnalyticsCharts.$inferSelect;
export type NewHelpdeskAnalyticsChart = typeof helpdeskAnalyticsCharts.$inferInsert;
