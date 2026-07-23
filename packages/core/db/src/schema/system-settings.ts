import {
  pgTable,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';

// System settings table - key-value store for system-wide configuration
export const systemSettings = pgTable('system_settings', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Setting identification
  key: varchar('key', { length: 100 }).notNull(),
  category: varchar('category', { length: 50 }).notNull().default('general'),

  // Value stored as JSONB for flexibility
  value: jsonb('value').$type<unknown>(),

  // Metadata
  description: text('description'),
  dataType: varchar('data_type', { length: 20 }).default('string'), // string, number, boolean, json

  // Audit trail
  updatedBy: varchar('updated_by', { length: 255 }),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('system_settings_key_unique').on(table.key),
  index('system_settings_category_idx').on(table.category),
]);

export type SystemSetting = typeof systemSettings.$inferSelect;
export type NewSystemSetting = typeof systemSettings.$inferInsert;

// Common setting categories
export const SETTING_CATEGORIES = {
  general: 'General',
  billing: 'Billing',
  email: 'Email',
  security: 'Security',
  integrations: 'Integrations',
} as const;

export type SettingCategory = keyof typeof SETTING_CATEGORIES;
