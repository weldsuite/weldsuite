import { pgTable, varchar, text, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core';

// Workspace settings - organization-level configuration
export const workspaceSettings = pgTable('workspace_settings', {
  id: varchar('id', { length: 255 }).primaryKey(),

  // Default appearance/localization (workspace-level defaults)
  theme: text('theme'),
  timezone: text('timezone'),
  currency: text('currency'),
  language: text('language'),
  dateFormat: text('date_format'),
  timeFormat: text('time_format'),

  // Business information
  legalName: varchar('legal_name', { length: 255 }),
  tradingName: varchar('trading_name', { length: 255 }),
  contactFirstName: varchar('contact_first_name', { length: 255 }),
  contactLastName: varchar('contact_last_name', { length: 255 }),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 30 }),

  // Address
  addressLine1: varchar('address_line_1', { length: 255 }),
  addressLine2: varchar('address_line_2', { length: 255 }),
  city: varchar('city', { length: 100 }),
  state: varchar('state', { length: 100 }),
  postalCode: varchar('postal_code', { length: 20 }),
  country: varchar('country', { length: 100 }),

  // Tax/registration
  vatNumber: varchar('vat_number', { length: 50 }),
  registrationNumber: varchar('registration_number', { length: 50 }),

  // Branding
  logoUrl: varchar('logo_url', { length: 500 }),
  websiteUrl: varchar('website_url', { length: 500 }),
  primaryColor: varchar('primary_color', { length: 20 }),
  accentColor: varchar('accent_color', { length: 20 }),

  // Notification settings
  emailNotificationsEnabled: boolean('email_notifications_enabled').notNull().default(true),
  pushNotificationsEnabled: boolean('push_notifications_enabled').notNull().default(true),

  // Feature flags
  features: jsonb('features').$type<{
    multiCurrency?: boolean;
    advancedReporting?: boolean;
    apiAccess?: boolean;
    customDomain?: boolean;
    whiteLabel?: boolean;
  }>(),

  // @deprecated - Billing is now managed via Clerk Billing. These columns are kept for migration/backwards compatibility.
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),

  // Custom settings (extensible JSON)
  customSettings: jsonb('custom_settings').$type<Record<string, unknown>>(),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type WorkspaceSetting = typeof workspaceSettings.$inferSelect;
export type NewWorkspaceSetting = typeof workspaceSettings.$inferInsert;
