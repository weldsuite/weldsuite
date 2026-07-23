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

// DNS status enum
export const mailDomainDnsStatusEnum = pgEnum('mail_domain_dns_status', [
  'pending',
  'verified',
  'failed',
]);

// DNS record interface (stored as JSONB)
export interface MailDnsRecord {
  type: string;
  name: string;
  value: string;
  priority?: number;
  ttl?: number;
  verified?: boolean;
  purpose?: 'spf' | 'dkim' | 'dmarc' | 'mx' | 'verification' | 'other';
}

// Mail Domains table
export const mailDomains = pgTable('mail_domains', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Domain Information
  domainName: varchar('domain_name', { length: 255 }).notNull(),
  isActive: boolean('is_active').notNull().default(false),
  isPrimary: boolean('is_primary').default(false),

  // Provider — Cloudflare Email Routing. Existing rows with older provider
  // values continue to work; the column is a free-form varchar.
  mailProvider: varchar('mail_provider', { length: 100 }).default('cloudflare'),
  // Send/Receive provider overrides
  sendProvider: varchar('send_provider', { length: 50 }).default('cloudflare'),
  receiveProvider: varchar('receive_provider', { length: 50 }).default('cloudflare'),

  // Limits
  maxEmailAccounts: integer('max_email_accounts').default(10),
  currentEmailAccounts: integer('current_email_accounts').default(0),

  // DNS Verification
  dnsStatus: mailDomainDnsStatusEnum('dns_status').default('pending'),
  dnsRecords: jsonb('dns_records').$type<MailDnsRecord[]>(),
  verifiedAt: timestamp('verified_at'),
  lastVerificationAttempt: timestamp('last_verification_attempt'),

  // SPF/DKIM/DMARC status
  spfVerified: boolean('spf_verified').default(false),
  dkimVerified: boolean('dkim_verified').default(false),
  dmarcVerified: boolean('dmarc_verified').default(false),
  dkimSelector: varchar('dkim_selector', { length: 100 }),
  dkimPublicKey: text('dkim_public_key'),

  // External sync (Mailcow integration - legacy)
  externalDomainId: varchar('external_domain_id', { length: 255 }),
  mailcowDomainId: varchar('mailcow_domain_id', { length: 255 }),
  mailcowSyncedAt: timestamp('mailcow_synced_at'),

  // Resend integration
  resendDomainId: varchar('resend_domain_id', { length: 255 }),
  resendStatus: varchar('resend_status', { length: 50 }),
  resendSyncedAt: timestamp('resend_synced_at'),

  // Cloudflare Email Routing integration
  cloudflareZoneId: varchar('cloudflare_zone_id', { length: 255 }),
  cloudflareRoutingEnabled: boolean('cloudflare_routing_enabled').default(false),
  /** Catch-all routing rule id returned by `PUT /zones/{id}/email/routing/rules/catch_all`. */
  cloudflareRoutingRuleId: varchar('cloudflare_routing_rule_id', { length: 255 }),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('mail_domains_domain_name_idx').on(table.domainName),
  index('mail_domains_is_active_idx').on(table.isActive),
  index('mail_domains_is_primary_idx').on(table.isPrimary),
  index('mail_domains_external_domain_id_idx').on(table.externalDomainId),
]);

export type MailDomain = typeof mailDomains.$inferSelect;
export type NewMailDomain = typeof mailDomains.$inferInsert;
