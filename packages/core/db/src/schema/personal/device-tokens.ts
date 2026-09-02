import {
  pgTable,
  varchar,
  timestamp,
  text,
  index,
  unique,
} from 'drizzle-orm/pg-core';

/**
 * Push notification tokens for PERSONAL (consumer WeldMail) accounts.
 *
 * The workspace equivalent lives in the tenant DB (`device_tokens`), keyed by
 * the Clerk org that owns the tenant. Personal accounts have no org and no
 * tenant DB, so their tokens need a home in the shared personal DB — without
 * this table a personal `@weldmail.com` address has nowhere to record a device
 * and can never be pushed to.
 *
 * `personalAccountId` scopes the row for reads by the owner; `clerkUserId` is
 * carried too because the inbound worker resolves a delivery to a Clerk user
 * (via `personal_accounts.clerk_user_id`) and pushes without loading the
 * personal account row.
 *
 * Shape mirrors the tenant table so `sendExpoPush` handling — ticket errors,
 * token deactivation — stays identical across both tenancies.
 */
export const personalDeviceTokens = pgTable('personal_device_tokens', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  personalAccountId: varchar('personal_account_id', { length: 30 }).notNull(),
  /** Clerk user id — the push target the inbound worker resolves to. */
  clerkUserId: varchar('clerk_user_id', { length: 255 }).notNull(),

  deviceId: varchar('device_id', { length: 255 }).notNull(),
  platform: varchar('platform', { length: 20 }).notNull(), // 'ios', 'android', 'web'

  token: text('token').notNull(), // e.g. ExponentPushToken[...]
  tokenType: varchar('token_type', { length: 20 }).notNull().default('expo'), // 'expo', 'fcm', 'apns'

  appCode: varchar('app_code', { length: 50 }).notNull().default('weldmail'),
  appVersion: varchar('app_version', { length: 50 }),
  deviceModel: varchar('device_model', { length: 100 }),
  osVersion: varchar('os_version', { length: 50 }),

  // null = active, set = deactivated at. Matches the tenant table's convention
  // so the shared push code can use the same `isNull(isActive)` filter.
  isActive: timestamp('is_active'),
  lastUsedAt: timestamp('last_used_at'),
}, (table) => [
  index('personal_device_tokens_personal_account_idx').on(table.personalAccountId),
  index('personal_device_tokens_clerk_user_idx').on(table.clerkUserId),
  index('personal_device_tokens_app_code_idx').on(table.appCode),
  // One row per device per app for a given account — re-registering the same
  // device (token refresh, reinstall) updates in place rather than piling up
  // stale tokens that Expo would reject one by one.
  unique('personal_device_tokens_account_device_app_unique').on(
    table.personalAccountId,
    table.deviceId,
    table.appCode,
  ),
]);

export type PersonalDeviceToken = typeof personalDeviceTokens.$inferSelect;
export type NewPersonalDeviceToken = typeof personalDeviceTokens.$inferInsert;
