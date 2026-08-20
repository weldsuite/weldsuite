import {
  pgTable,
  varchar,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Per-workspace B2B customer portal settings. One row is enough; the public
 * renderer 404s when `isEnabled` is off or the row is missing.
 */
export const commercePortalSettings = pgTable('commerce_portal_settings', {
  id: varchar('id', { length: 30 }).primaryKey(),

  isEnabled: integer('is_enabled').notNull().default(0),

  displayName: varchar('display_name', { length: 255 }),
  logo: varchar('logo', { length: 500 }),
  primaryColor: varchar('primary_color', { length: 20 }),
  accentColor: varchar('accent_color', { length: 20 }),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('commerce_portal_settings_enabled_idx').on(table.isEnabled),
]);

export type CommercePortalSettings = typeof commercePortalSettings.$inferSelect;
export type NewCommercePortalSettings = typeof commercePortalSettings.$inferInsert;

export type CommercePortalAccessStatus = 'invited' | 'active' | 'revoked';

/**
 * Grants a CRM person at a company the right to sign in to the B2B portal.
 * Unique per (person, company); revoke is a status flip, not a delete, so a
 * later re-invite updates the same row.
 */
export const commercePortalAccess = pgTable('commerce_portal_access', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  personId: varchar('person_id', { length: 30 }).notNull(),
  companyId: varchar('company_id', { length: 30 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),

  status: varchar('status', { length: 20 }).notNull().default('invited'),

  invitedBy: varchar('invited_by', { length: 255 }),
  invitedAt: timestamp('invited_at'),
  lastLoginAt: timestamp('last_login_at'),
}, (table) => [
  uniqueIndex('commerce_portal_access_person_company_uidx').on(table.personId, table.companyId),
  index('commerce_portal_access_email_idx').on(table.email),
  index('commerce_portal_access_company_idx').on(table.companyId),
  index('commerce_portal_access_status_idx').on(table.status),
]);

export type CommercePortalAccess = typeof commercePortalAccess.$inferSelect;
export type NewCommercePortalAccess = typeof commercePortalAccess.$inferInsert;
