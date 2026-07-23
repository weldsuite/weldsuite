import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

// Domain status enum
export const hostDomainStatusEnum = pgEnum('host_domain_status', [
  'active',
  'pending',
  'expired',
  'suspended',
  'cancelled',
]);

// Domain registration status enum
export const hostDomainRegistrationStatusEnum = pgEnum('host_domain_registration_status', [
  'pending_payment',
  'pending_registration',
  'pending_workflow',
  'registered',
  'pending_transfer',
  'transferred',
  'pending_renewal',
  'renewed',
  'failed',
  'registration_failed',
]);

// Domain contact interface (stored as JSONB)
export interface DomainContact {
  firstName?: string;
  lastName?: string;
  organization?: string;
  email?: string;
  phone?: string;
  fax?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

// Domains table
export const hostDomains = pgTable('domains', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Domain identification
  name: varchar('name', { length: 255 }).notNull(), // e.g., "example"
  tld: varchar('tld', { length: 50 }).notNull(), // e.g., "com"
  fullDomain: varchar('full_domain', { length: 255 }).notNull(), // e.g., "example.com"

  // Status
  status: hostDomainStatusEnum('status').notNull().default('pending'),
  registrationStatus: hostDomainRegistrationStatusEnum('registration_status'),

  // Registrar info
  registrar: varchar('registrar', { length: 255 }), // e.g., "cloudflare"
  externalRegistrarId: varchar('external_registrar_id', { length: 255 }), // CF domain identifier
  registrarStatus: varchar('registrar_status', { length: 100 }), // CF status enum value
  registrarSyncedAt: timestamp('registrar_synced_at'),

  // Cloudflare async workflow support — set when CF returns 202 on registration
  workflowUrl: text('workflow_url'),

  // Important dates
  registeredAt: timestamp('registered_at'),
  expiresAt: timestamp('expires_at'),
  renewedAt: timestamp('renewed_at'),

  // Nameserver configuration
  nameservers: jsonb('nameservers').$type<string[]>(), // Array of nameserver domains
  customNameservers: boolean('custom_nameservers').default(false),
  nameserverVerified: boolean('nameserver_verified').default(false),
  nameserverVerificationPending: boolean('nameserver_verification_pending').default(false),
  nameserverVerificationToken: varchar('nameserver_verification_token', { length: 255 }),

  // Domain settings
  autoRenew: boolean('auto_renew').default(true),
  privacyProtection: boolean('privacy_protection').default(false),
  locked: boolean('locked').default(true), // Transfer lock
  sslEnabled: boolean('ssl_enabled').default(false),
  emailForwardingEnabled: boolean('email_forwarding_enabled').default(false),

  // Stripe payment tracking — set when a checkout session is created
  stripeSessionId: text('stripe_session_id'),

  // Auth code for transfers
  authCode: varchar('auth_code', { length: 255 }),
  authCodeExpiresAt: timestamp('auth_code_expires_at'),

  // Contact information (JSONB)
  registrantContact: jsonb('registrant_contact').$type<DomainContact>(),
  adminContact: jsonb('admin_contact').$type<DomainContact>(),
  techContact: jsonb('tech_contact').$type<DomainContact>(),
  billingContact: jsonb('billing_contact').$type<DomainContact>(),

  // Additional metadata
  notes: text('notes'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('domains_full_domain_idx').on(table.fullDomain),
  index('domains_status_idx').on(table.status),
  index('domains_expires_at_idx').on(table.expiresAt),
  index('domains_external_registrar_id_idx').on(table.externalRegistrarId),
]);

export type HostDomain = typeof hostDomains.$inferSelect;
export type NewHostDomain = typeof hostDomains.$inferInsert;
