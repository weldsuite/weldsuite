import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  index,
  text,
} from 'drizzle-orm/pg-core';

/**
 * Phone number type enum values
 */
export const PHONE_NUMBER_TYPES = ['local', 'toll_free', 'mobile'] as const;
export type PhoneNumberType = (typeof PHONE_NUMBER_TYPES)[number];

/**
 * Phone number status enum values
 */
export const PHONE_NUMBER_STATUSES = [
  'active',       // Number is active and can make/receive calls
  'pending',      // Number is being provisioned
  'suspended',    // Number is temporarily suspended
  'released',     // Number has been released
] as const;
export type PhoneNumberStatus = (typeof PHONE_NUMBER_STATUSES)[number];

/**
 * VoIP phone numbers table - platform phone numbers assigned to workspaces
 */
export const voipPhoneNumbers = pgTable('voip_phone_numbers', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // VoIP provider
  provider: varchar('provider', { length: 20 }).notNull().default('telnyx'),

  // Phone number details
  phoneNumber: varchar('phone_number', { length: 50 }).notNull().unique(),
  formattedNumber: varchar('formatted_number', { length: 50 }),
  countryCode: varchar('country_code', { length: 5 }).notNull(),
  numberType: varchar('number_type', { length: 20 }).default('local'), // local, toll_free, mobile

  // Provider-specific identifiers
  providerPhoneNumberId: varchar('provider_phone_number_id', { length: 255 }), // Telnyx: phone_number_id
  providerConnectionId: varchar('provider_connection_id', { length: 255 }), // Telnyx: connection_id

  // Status
  status: varchar('status', { length: 20 }).notNull().default('active'),

  // Assignment
  assignedUserId: varchar('assigned_user_id', { length: 255 }), // Optional: specific user assignment
  assignedAt: timestamp('assigned_at'),

  // Configuration
  isDefault: boolean('is_default').default(false), // Default outbound number for workspace
  allowInbound: boolean('allow_inbound').default(true),
  allowOutbound: boolean('allow_outbound').default(true),
  enableRecording: boolean('enable_recording').default(true),

  // Display settings
  displayName: varchar('display_name', { length: 100 }),
  description: text('description'),

  // Soft delete
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('voip_phone_numbers_user_idx').on(table.assignedUserId),
  index('voip_phone_numbers_status_idx').on(table.status),
  index('voip_phone_numbers_country_idx').on(table.countryCode),
  index('voip_phone_numbers_provider_id_idx').on(table.providerPhoneNumberId),
  index('voip_phone_numbers_provider_idx').on(table.provider),
]);

export type VoipPhoneNumber = typeof voipPhoneNumbers.$inferSelect;
export type NewVoipPhoneNumber = typeof voipPhoneNumbers.$inferInsert;

