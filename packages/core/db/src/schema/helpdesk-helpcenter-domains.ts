import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const helpcenterDomains = pgTable('helpcenter_domains', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Parent Settings
  helpcenterSettingsId: varchar('helpcenter_settings_id', { length: 30 }).notNull(),

  // Domain Info
  domain: varchar('domain', { length: 255 }).notNull(),
  subdomain: varchar('subdomain', { length: 100 }),
  rootDomain: varchar('root_domain', { length: 255 }),

  // Type
  domainType: varchar('domain_type', { length: 20 }).default('custom'),
  // 'custom' | 'subdomain' (e.g., acme.welddesk.org)

  // Status
  isPrimary: integer('is_primary').default(0),
  isVerified: integer('is_verified').default(0),
  isActive: integer('is_active').default(0),

  // Verification
  verificationMethod: varchar('verification_method', { length: 20 }),
  // 'dns_txt' | 'dns_cname'
  verificationToken: varchar('verification_token', { length: 255 }),
  verifiedAt: timestamp('verified_at'),
  lastVerificationAttempt: timestamp('last_verification_attempt'),
  verificationError: varchar('verification_error', { length: 500 }),

  // DNS Configuration
  dnsConfig: jsonb('dns_config').$type<Array<{ type: string; name: string; value: string }>>(),
  dnsStatus: varchar('dns_status', { length: 20 }).default('pending'),
  // 'pending' | 'configured' | 'propagating' | 'active' | 'error'

  // SSL
  sslStatus: varchar('ssl_status', { length: 20 }).default('pending'),
  // 'pending' | 'provisioning' | 'active' | 'expired' | 'error'
}, (table) => [
  index('helpcenter_domains_settings_idx').on(table.helpcenterSettingsId),
  index('helpcenter_domains_domain_idx').on(table.domain),
  index('helpcenter_domains_is_primary_idx').on(table.isPrimary),
]);

export type HelpcenterDomain = typeof helpcenterDomains.$inferSelect;
export type NewHelpcenterDomain = typeof helpcenterDomains.$inferInsert;
