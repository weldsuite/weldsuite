import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export interface DeskWidgetBranding {
  primaryColor?: string;
  backgroundColor?: string;
  position?: 'right' | 'left';
}

export type DeskWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** One opening window on a weekday: wall-clock `HH:MM` in the widget's timezone, end may be `24:00`. */
export interface DeskOfficeHoursWindow {
  start: string;
  end: string;
}

/**
 * Weekly office hours. With `enabled` false the team counts as always
 * available. A weekday that is missing or null is closed all day.
 */
export interface DeskOfficeHours {
  enabled: boolean;
  days: Partial<Record<DeskWeekday, DeskOfficeHoursWindow | null>>;
}

/** How soon visitors can expect an answer; the widget words it in their language. */
export type DeskExpectedReplyTime = 'few_minutes' | 'hour' | 'few_hours' | 'day';

export const deskWidgetSettings = pgTable(
  'desk_widget_settings',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    widgetId: varchar('widget_id', { length: 40 }).notNull(),
    widgetName: varchar('widget_name', { length: 255 }),
    enabled: boolean('enabled').notNull().default(true),

    greeting: varchar('greeting', { length: 500 }),
    branding: jsonb('branding').$type<DeskWidgetBranding>(),
    allowedDomains: jsonb('allowed_domains').$type<string[]>(),

    officeHours: jsonb('office_hours').$type<DeskOfficeHours>(),
    /** IANA zone the office hours are written in, e.g. Europe/Amsterdam. */
    timezone: varchar('timezone', { length: 64 }),
    /** Shown to visitors outside office hours; the widget has a default. */
    awayMessage: varchar('away_message', { length: 1000 }),
    expectedReplyTime: varchar('expected_reply_time', { length: 20 }).$type<DeskExpectedReplyTime>(),
  },
  (table) => [
    uniqueIndex('desk_widget_settings_widget_id_idx').on(table.widgetId),
  ],
);

export type DeskWidgetSettings = typeof deskWidgetSettings.$inferSelect;
export type NewDeskWidgetSettings = typeof deskWidgetSettings.$inferInsert;
