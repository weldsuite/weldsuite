import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { hostDnsZones } from './host-dns-zones';

// DNS record type enum
export const hostDnsRecordTypeEnum = pgEnum('host_dns_record_type', [
  'A',
  'AAAA',
  'CNAME',
  'MX',
  'TXT',
  'NS',
  'SRV',
  'CAA',
  'PTR',
  'SOA',
]);

// DNS record status enum
export const hostDnsRecordStatusEnum = pgEnum('host_dns_record_status', [
  'active',
  'pending',
  'error',
  'disabled',
]);

// DNS Records table
export const hostDnsRecords = pgTable('dns_records', {
  id: varchar('id', { length: 30 }).primaryKey(),
  zoneId: varchar('zone_id', { length: 30 }).notNull().references(() => hostDnsZones.id),

  // External provider info
  externalRecordId: varchar('external_record_id', { length: 255 }), // ID at DNS provider

  // Record type
  type: hostDnsRecordTypeEnum('type').notNull(),

  // Record data
  name: varchar('name', { length: 255 }).notNull(), // Subdomain or @ for root
  value: text('value').notNull(), // Record value (IP, hostname, etc.)
  ttl: integer('ttl').notNull().default(3600), // Time to live in seconds

  // Type-specific fields
  priority: integer('priority'), // For MX records
  weight: integer('weight'), // For SRV records
  port: integer('port'), // For SRV records

  // CAA specific
  caaFlag: integer('caa_flag'), // 0 or 128
  caaTag: varchar('caa_tag', { length: 50 }), // issue, issuewild, iodef

  // Status
  status: hostDnsRecordStatusEnum('status').notNull().default('active'),
  syncError: varchar('sync_error', { length: 1000 }),
  syncedAt: timestamp('synced_at'),

  // Metadata
  comment: varchar('comment', { length: 500 }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('dns_records_zone_id_idx').on(table.zoneId),
  index('dns_records_type_idx').on(table.type),
  index('dns_records_name_idx').on(table.name),
  index('dns_records_external_record_id_idx').on(table.externalRecordId),
]);

export type HostDnsRecord = typeof hostDnsRecords.$inferSelect;
export type NewHostDnsRecord = typeof hostDnsRecords.$inferInsert;
