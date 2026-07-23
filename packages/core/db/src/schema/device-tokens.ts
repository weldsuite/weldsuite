import {
  pgTable,
  varchar,
  timestamp,
  text,
  index,
  unique,
} from 'drizzle-orm/pg-core';

/**
 * Device tokens table for storing push notification tokens
 * Used for sending push notifications to mobile devices
 */
export const deviceTokens = pgTable('device_tokens', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // User/Device Information
  userId: varchar('user_id', { length: 255 }).notNull(),
  deviceId: varchar('device_id', { length: 255 }).notNull(), // Unique device identifier
  platform: varchar('platform', { length: 20 }).notNull(), // 'ios', 'android', 'web'

  // Push Token
  token: text('token').notNull(), // Push token (e.g. ExponentPushToken[...])
  tokenType: varchar('token_type', { length: 20 }).notNull().default('expo'), // 'expo', 'fcm', 'apns'

  // App Information
  appCode: varchar('app_code', { length: 50 }).notNull().default('weldsuite'),
  appVersion: varchar('app_version', { length: 50 }),
  deviceModel: varchar('device_model', { length: 100 }),
  osVersion: varchar('os_version', { length: 50 }),

  // Status — null = active, set = deactivated at. Nullable by default;
  // no `.default(null)` because Drizzle's typings reject null literals
  // there (any nullable column already implicitly defaults to NULL).
  isActive: timestamp('is_active'),
  lastUsedAt: timestamp('last_used_at'),
}, (table) => [
  index('device_tokens_user_idx').on(table.userId),
  index('device_tokens_platform_idx').on(table.platform),
  index('device_tokens_app_code_idx').on(table.appCode),
  unique('device_tokens_user_device_app_unique').on(table.userId, table.deviceId, table.appCode),
]);

export type DeviceToken = typeof deviceTokens.$inferSelect;
export type NewDeviceToken = typeof deviceTokens.$inferInsert;
