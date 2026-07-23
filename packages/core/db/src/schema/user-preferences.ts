import { pgTable, varchar, integer, timestamp, jsonb } from 'drizzle-orm/pg-core';
import type { WorkingHours } from './helpdesk-agents';

// User preferences - appearance settings per user per workspace
export const userPreferences = pgTable('user_preferences', {
  id: varchar('id', { length: 30 }).primaryKey(),
  userId: varchar('user_id', { length: 255 }).notNull(),

  // Appearance
  theme: varchar('theme', { length: 20 }).notNull().default('system'),
  fontSize: integer('font_size').notNull().default(16),

  // Localization
  language: varchar('language', { length: 10 }).notNull().default('en'),
  dateFormat: varchar('date_format', { length: 50 }).notNull().default('MM/DD/YYYY'),
  timeFormat: varchar('time_format', { length: 10 }).notNull().default('12h'),
  timezone: varchar('timezone', { length: 100 }).notNull().default('UTC'),

  // Notification preferences (JSON)
  notifications: jsonb('notifications').$type<{
    email?: boolean;
    push?: boolean;
    desktop?: boolean;
    sound?: boolean;
  }>(),

  // Working hours for auto-scheduling
  workingHours: jsonb('working_hours').$type<WorkingHours>(),

  // Additional UI preferences (JSON)
  uiPreferences: jsonb('ui_preferences').$type<{
    sidebarCollapsed?: boolean;
    compactMode?: boolean;
    showWelcome?: boolean;
    defaultView?: string;
    sidebarAppOrder?: string[];
    onboardingCompleted?: boolean;
    onboardingCompletedAt?: string;
    primaryRole?: string;
    /** WeldMail: account to open by default (accountId or 'unified'). null = no preference. */
    mailDefaultAccountId?: string | null;
    /** WeldMail: last account/view the user opened (accountId or 'unified'). Fallback landing. */
    mailLastAccountId?: string | null;
    homeWidgets?: {
      slots: [
        { widgetId: string; settings: Record<string, unknown> } | null,
        { widgetId: string; settings: Record<string, unknown> } | null,
      ];
    };
  }>(),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type UserPreference = typeof userPreferences.$inferSelect;
export type NewUserPreference = typeof userPreferences.$inferInsert;
