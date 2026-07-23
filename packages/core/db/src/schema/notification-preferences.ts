import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Per-module notification channel settings
export interface ModuleChannelPreferences {
  enabled: boolean;
  inApp: boolean;
  email: boolean;
  push: boolean;
  desktop: boolean;
}

// Module preferences map
export interface ModulePreferencesMap {
  helpdesk?: ModuleChannelPreferences;
  crm?: ModuleChannelPreferences;
  wms?: ModuleChannelPreferences;
  commerce?: ModuleChannelPreferences;
  mail?: ModuleChannelPreferences;
  projects?: ModuleChannelPreferences;
  parcel?: ModuleChannelPreferences;
  task?: ModuleChannelPreferences;
  digest?: ModuleChannelPreferences;
  weldchat?: ModuleChannelPreferences;
}

// Default module preferences (all enabled)
export const defaultModulePreferences: ModuleChannelPreferences = {
  enabled: true,
  inApp: true,
  email: false,
  push: true,
  desktop: true,
};

export const notificationPreferences = pgTable('notification_preferences', {
  // Base fields
  id: varchar('id', { length: 30 }).primaryKey(),
  userId: varchar('user_id', { length: 255 }).notNull(),

  // Global settings
  doNotDisturb: boolean('do_not_disturb').notNull().default(false),
  soundEnabled: boolean('sound_enabled').notNull().default(true),

  // Per-module preferences (JSONB for flexibility)
  modulePreferences: jsonb('module_preferences').$type<ModulePreferencesMap>(),

  // Default channel preferences (used when module-specific not set)
  defaultInApp: boolean('default_in_app').notNull().default(true),
  defaultEmail: boolean('default_email').notNull().default(false),
  defaultPush: boolean('default_push').notNull().default(true),
  defaultDesktop: boolean('default_desktop').notNull().default(true),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Each user can only have one preference record
  uniqueIndex('notification_preferences_user_idx').on(table.userId),
]);

export type NotificationPreference = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreference = typeof notificationPreferences.$inferInsert;
