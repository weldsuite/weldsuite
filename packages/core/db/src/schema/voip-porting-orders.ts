import {
  pgTable,
  varchar,
  timestamp,
  text,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Phone number port-in orders.
 *
 * Tracks the lifecycle of moving a customer's existing phone number from
 * their current carrier (KPN, Vodafone, BT, etc.) into the platform's
 * Telnyx account. Once the port completes, a row in voipPhoneNumbers is
 * created and linked via voipPhoneNumberId.
 *
 * The number itself is owned by the platform Telnyx account after porting —
 * billing flows through the existing telephonyNumberPricing → Stripe path,
 * call control runs on the platform's existing TELNYX_CONNECTION_ID, and
 * inbound rings the user via Telnyx's WebRTC credential push.
 */

export const PORTING_ORDER_STATUSES = [
  'draft',                // Created, missing details/documents
  'preflight_failed',     // Telnyx /porting_phone_number_check said no
  'awaiting_documents',   // Customer info filled, waiting for LOA + bill upload
  'submitted',            // Sent to Telnyx for approval
  'in_process',           // Telnyx working with losing carrier
  'exception',            // Telnyx flagged a problem (rejection, missing info)
  'cancelled',            // User cancelled (only allowed pre-submit)
  'completed',            // Number is now live on our Telnyx account
] as const;
export type PortingOrderStatus = (typeof PORTING_ORDER_STATUSES)[number];

export const PORTABLE_NUMBER_TYPES = ['local', 'mobile'] as const;
export type PortableNumberType = (typeof PORTABLE_NUMBER_TYPES)[number];

export interface PortingServiceAddress {
  line1: string;
  line2?: string;
  city: string;
  region: string;          // state / province
  postalCode: string;
  country: string;         // ISO-2
}

export const voipPortingOrders = pgTable(
  'voip_porting_orders',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),

    // Number being ported (E.164)
    phoneNumber: varchar('phone_number', { length: 50 }).notNull(),
    formattedNumber: varchar('formatted_number', { length: 50 }),
    countryCode: varchar('country_code', { length: 5 }).notNull(),
    numberType: varchar('number_type', { length: 20 }).notNull().default('local'),

    // Telnyx side. NULL until POST /porting_orders returns; from then on
    // every Telnyx interaction is keyed off this. UNIQUE so we never wire
    // two of our rows to the same Telnyx order.
    telnyxPortingOrderId: varchar('telnyx_porting_order_id', { length: 100 }),

    status: varchar('status', { length: 30 }).notNull().default('draft'),
    // Mirrors Telnyx sub_status verbatim — useful for surfacing finer
    // states like "FOC date issued", "Awaiting customer signature".
    substatus: varchar('substatus', { length: 100 }),

    requestedFocAt: timestamp('requested_foc_at'),
    actualFocAt: timestamp('actual_foc_at'),

    // Customer/business snapshot. Snapshotted at submit time — Telnyx (and
    // the losing carrier) treat this as the authoritative request, and
    // editing post-submit is forbidden by Telnyx's API.
    authorizedName: varchar('authorized_name', { length: 200 }),
    businessName: varchar('business_name', { length: 200 }),
    serviceAddress: jsonb('service_address').$type<PortingServiceAddress>(),
    currentCarrier: varchar('current_carrier', { length: 100 }),
    currentAccountNumber: varchar('current_account_number', { length: 100 }),
    // Some carriers (Verizon, T-Mobile US, certain EU mobile carriers)
    // require a transfer PIN. Optional everywhere else.
    currentPin: varchar('current_pin', { length: 50 }),

    // R2 keys — the actual files live in env.STORAGE under
    // port-orders/{workspaceId}/{orderId}/{loa|bill}.pdf
    loaStorageKey: varchar('loa_storage_key', { length: 500 }),
    billCopyStorageKey: varchar('bill_copy_storage_key', { length: 500 }),

    // Pricing snapshot — looked up + locked when user clicks Submit so
    // they can't dodge a rate change mid-port.
    stripePriceId: varchar('stripe_price_id', { length: 255 }),

    // Set true after the post-completion billing-worker call succeeds. If
    // billing failed (next field), we keep the number active anyway (we
    // can't un-port) and an admin needs to reconcile manually.
    billingActivated: boolean('billing_activated').notNull().default(false),
    billingError: text('billing_error'),

    lastErrorCode: varchar('last_error_code', { length: 80 }),
    lastErrorMessage: text('last_error_message'),

    // Set when status flips to 'completed' and we successfully insert the
    // voipPhoneNumbers row. Lets the UI deep-link from the port order to
    // the now-live number.
    voipPhoneNumberId: varchar('voip_phone_number_id', { length: 30 }),

    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    uniqueIndex('voip_porting_orders_telnyx_id_idx')
      .on(table.telnyxPortingOrderId)
      .where(sql`${table.telnyxPortingOrderId} IS NOT NULL`),
    // Stop the user from kicking off two simultaneous ports for the same
    // number. We allow a fresh attempt after a previous one was cancelled,
    // failed pre-flight, or hit an exception.
    uniqueIndex('voip_porting_orders_active_phone_idx')
      .on(table.phoneNumber)
      .where(sql`${table.deletedAt} IS NULL AND ${table.status} NOT IN ('cancelled','exception','preflight_failed','completed')`),
    index('voip_porting_orders_status_idx').on(table.status),
    index('voip_porting_orders_phone_idx').on(table.phoneNumber),
    index('voip_porting_orders_created_by_idx').on(table.createdByUserId),
  ],
);

export type VoipPortingOrder = typeof voipPortingOrders.$inferSelect;
export type NewVoipPortingOrder = typeof voipPortingOrders.$inferInsert;
