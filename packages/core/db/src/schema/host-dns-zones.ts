import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { hostDomains } from './host-domains';

// DNS zone status enum
export const hostDnsZoneStatusEnum = pgEnum('host_dns_zone_status', [
  'active',
  'pending',
  'disabled',
  'error',
]);

// DNS provider enum
export const hostDnsProviderEnum = pgEnum('host_dns_provider', [
  'hetzner',
  'cloudflare',
  'route53',
  'custom',
]);

// DNSSEC key info (stored as JSONB)
export interface DnssecKey {
  keyTag: number;
  algorithm: number;
  digestType: number;
  digest: string;
  publicKey?: string;
  flags?: number;
}

// DNS Zones table
export const hostDnsZones = pgTable('dns_zones', {
  id: varchar('id', { length: 30 }).primaryKey(),
  domainId: varchar('domain_id', { length: 30 }).notNull().references(() => hostDomains.id),

  // Zone identification
  name: varchar('name', { length: 255 }).notNull(), // Zone name (usually same as domain)

  // Status
  status: hostDnsZoneStatusEnum('status').notNull().default('pending'),

  // External provider info
  provider: hostDnsProviderEnum('provider').notNull().default('hetzner'),
  externalZoneId: varchar('external_zone_id', { length: 255 }), // ID at DNS provider (e.g., Hetzner zone ID)
  externalNameservers: jsonb('external_nameservers').$type<string[]>(), // Provider's nameservers
  syncedAt: timestamp('synced_at'),
  syncError: varchar('sync_error', { length: 1000 }),

  // DNSSEC
  dnssecEnabled: boolean('dnssec_enabled').default(false),
  dnssecKeys: jsonb('dnssec_keys').$type<DnssecKey[]>(),

  // Zone settings
  defaultTtl: integer('default_ttl').default(3600), // Default TTL in seconds
  refreshInterval: integer('refresh_interval').default(86400), // SOA refresh
  retryInterval: integer('retry_interval').default(7200), // SOA retry
  expireTime: integer('expire_time').default(3600000), // SOA expire
  minimumTtl: integer('minimum_ttl').default(3600), // SOA minimum

  // Record counts (cached for quick access)
  recordCount: integer('record_count').default(0),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('dns_zones_domain_id_idx').on(table.domainId),
  index('dns_zones_external_zone_id_idx').on(table.externalZoneId),
  index('dns_zones_status_idx').on(table.status),
]);

export type HostDnsZone = typeof hostDnsZones.$inferSelect;
export type NewHostDnsZone = typeof hostDnsZones.$inferInsert;
