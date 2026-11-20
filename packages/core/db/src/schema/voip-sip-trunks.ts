import {
  pgTable,
  varchar,
  timestamp,
  text,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** The phone system on the other end; a label for the setup steps, not a behaviour. */
export const SIP_TRUNK_PROVIDERS = ['xelion', 'dstny', 'other'] as const;
export type SipTrunkProvider = (typeof SIP_TRUNK_PROVIDERS)[number];

/**
 * How the customer's phone system proves who it is when it sends us a call:
 *   - `ip`: its public IP addresses are allow-listed (`ipAddresses`).
 *   - `credentials`: it signs in with a SIP username and password.
 */
export const SIP_TRUNK_AUTH_MODES = ['ip', 'credentials'] as const;
export type SipTrunkAuthMode = (typeof SIP_TRUNK_AUTH_MODES)[number];

export const SIP_TRUNK_TRANSPORTS = ['udp', 'tcp', 'tls'] as const;
export type SipTrunkTransport = (typeof SIP_TRUNK_TRANSPORTS)[number];

/**
 *   - `active`: calls are accepted.
 *   - `disabled`: switched off by a member; the carrier connection is inactive.
 */
export const SIP_TRUNK_STATUSES = ['active', 'disabled'] as const;
export type SipTrunkStatus = (typeof SIP_TRUNK_STATUSES)[number];

/** One allow-listed address of the customer's phone system. */
export interface SipTrunkIpAddress {
  ip: string;
  port?: number;
  /** The carrier's id of this address on the connection. */
  providerIpId?: string;
}

export const SIP_TRUNK_MAX_IP_ADDRESSES = 10;

/**
 * A customer's own phone system (a PBX or SIP trunk: Xelion, Dstny, …)
 * connected to WeldDesk, so they keep their numbers where they are instead
 * of porting them.
 *
 * Each trunk is its own connection at the carrier (`providerConnectionId`),
 * authenticated by IP address or by a SIP login. The phone system sends the
 * calls for its numbers to that connection; they arrive on the same webhook
 * as calls to our own numbers and follow the number's route
 * (desk_phone_routes). The numbers are `voip_phone_numbers` rows with
 * `sip_trunk_id` set.
 *
 * `sipUsername` is the login of a `credentials` trunk. Its password is made
 * by us, shown once and kept only at the carrier.
 */
export const voipSipTrunks = pgTable(
  'voip_sip_trunks',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    name: varchar('name', { length: 255 }).notNull(),
    provider: varchar('provider', { length: 20 }).$type<SipTrunkProvider>().notNull().default('other'),

    authMode: varchar('auth_mode', { length: 20 }).$type<SipTrunkAuthMode>().notNull(),
    ipAddresses: jsonb('ip_addresses').$type<SipTrunkIpAddress[]>().notNull().default([]),
    sipUsername: varchar('sip_username', { length: 64 }),
    transport: varchar('transport', { length: 5 }).$type<SipTrunkTransport>().notNull().default('udp'),

    /** The carrier's connection id (Telnyx: an IP or credential connection). */
    providerConnectionId: varchar('provider_connection_id', { length: 255 }),

    status: varchar('status', { length: 20 }).$type<SipTrunkStatus>().notNull().default('active'),

    /** The last call that came in over the trunk: the sign that the setup works. */
    lastInboundAt: timestamp('last_inbound_at'),
    /** Why the last call over the trunk was refused (an unknown number, a disabled trunk). */
    lastError: text('last_error'),

    createdById: varchar('created_by_id', { length: 255 }),
  },
  (table) => [
    uniqueIndex('voip_sip_trunks_connection_uidx').on(table.providerConnectionId),
    index('voip_sip_trunks_status_idx').on(table.status),
  ],
);

export type VoipSipTrunk = typeof voipSipTrunks.$inferSelect;
export type NewVoipSipTrunk = typeof voipSipTrunks.$inferInsert;
