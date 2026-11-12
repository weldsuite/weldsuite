import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const HELPDESK_REPORT_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type HelpdeskReportFrequency = (typeof HELPDESK_REPORT_FREQUENCIES)[number];

export const HELPDESK_REPORT_RUN_STATUSES = ['sent', 'failed'] as const;
export type HelpdeskReportRunStatus = (typeof HELPDESK_REPORT_RUN_STATUSES)[number];

/**
 * A WeldDesk report sent by email on a schedule.
 *
 * `reportId` null is the overview report (KPIs, backlog, per agent and team)
 * over `range`; otherwise it is a saved report (helpdesk_analytics_reports),
 * whose charts carry their own period.
 *
 * `nextRunAt` is the next send in UTC, computed from the frequency, the day,
 * `hour` and `timezone`. The sweep finds due schedules through the due index
 * (kind `desk_report`), so a workspace without schedules is never opened.
 */
export const helpdeskReportSchedules = pgTable(
  'helpdesk_report_schedules',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    name: varchar('name', { length: 255 }).notNull(),
    /** Saved report to send; null sends the overview. */
    reportId: varchar('report_id', { length: 30 }),
    /** Period the overview covers (a desk report range id, e.g. `last_7_days`). */
    range: varchar('range', { length: 30 }).notNull().default('last_7_days'),

    frequency: varchar('frequency', { length: 10 }).$type<HelpdeskReportFrequency>().notNull(),
    /** Weekly: 0 = Sunday … 6 = Saturday. */
    dayOfWeek: integer('day_of_week'),
    /** Monthly: 1 … 28. */
    dayOfMonth: integer('day_of_month'),
    /** Hour of the day in `timezone`, 0 … 23. */
    hour: integer('hour').notNull().default(8),
    /** IANA time zone the day and hour are read in. */
    timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),

    /** Email addresses the report goes to. */
    recipients: jsonb('recipients').$type<string[]>().notNull().default([]),
    /** Attach the numbers as a CSV file. */
    attachCsv: boolean('attach_csv').notNull().default(true),
    /** Language of the email (`en`, `nl`). */
    locale: varchar('locale', { length: 5 }).notNull().default('en'),

    enabled: boolean('enabled').notNull().default(true),
    createdById: varchar('created_by_id', { length: 255 }),

    nextRunAt: timestamp('next_run_at'),
    lastRunAt: timestamp('last_run_at'),
    lastStatus: varchar('last_status', { length: 20 }).$type<HelpdeskReportRunStatus>(),
    lastError: text('last_error'),
  },
  (table) => [
    index('helpdesk_report_schedules_due_idx').on(table.enabled, table.nextRunAt),
    index('helpdesk_report_schedules_report_idx').on(table.reportId),
  ],
);

export type HelpdeskReportSchedule = typeof helpdeskReportSchedules.$inferSelect;
export type NewHelpdeskReportSchedule = typeof helpdeskReportSchedules.$inferInsert;
