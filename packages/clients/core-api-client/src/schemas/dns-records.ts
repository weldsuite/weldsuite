/**
 * DNS record schemas (Zod v3).
 *
 * Powers `/api/dns-records/*` on `app-api`. Cloudflare is the source of
 * truth — every mutation re-syncs from CF so the response always carries
 * the freshly-reconciled record list.
 */

import { z } from 'zod';

export const dnsRecordTypeEnum = z.enum([
  'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'PTR', 'SOA',
]);

export const importableDnsRecordTypeEnum = z.enum([
  'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'CAA', 'SRV',
]);

export const listDnsRecordsQuery = z.object({
  zoneId: z.string().optional(),
  type: dnsRecordTypeEnum.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const createDnsRecordSchema = z.object({
  type: dnsRecordTypeEnum,
  name: z.string().min(1).max(255),
  value: z.string().min(1).max(2048),
  ttl: z.number().int().min(1).max(86400).optional(),
  priority: z.number().int().min(0).max(65535).optional(),
  comment: z.string().max(500).optional(),
});

export const updateDnsRecordSchema = createDnsRecordSchema;

export const toggleDnsRecordLockSchema = z.object({
  locked: z.boolean(),
  reason: z.string().max(500).optional(),
});

export const scannedDnsRecordSchema = z.object({
  name: z.string().min(1).max(255),
  type: importableDnsRecordTypeEnum,
  value: z.string().min(1).max(2048),
  ttl: z.number().int().min(1).max(86400).optional(),
  priority: z.number().int().min(0).max(65535).optional(),
});

export const importDnsRecordsSchema = z.object({
  records: z.array(scannedDnsRecordSchema).min(1).max(100),
});

export type ListDnsRecordsQuery = z.input<typeof listDnsRecordsQuery>;
export type CreateDnsRecordInput = z.infer<typeof createDnsRecordSchema>;
export type UpdateDnsRecordInput = z.infer<typeof updateDnsRecordSchema>;
export type ToggleDnsRecordLockInput = z.infer<typeof toggleDnsRecordLockSchema>;
export type ScannedDnsRecord = z.infer<typeof scannedDnsRecordSchema>;
export type ImportDnsRecordsInput = z.infer<typeof importDnsRecordsSchema>;

export interface DnsRecordLock {
  source: 'user' | 'weldmail' | string;
  sourceId?: string;
  purpose?: string;
  reason: string;
  lockedAt: string;
}

export interface DnsRecord {
  id: string;
  zoneId: string;
  externalRecordId: string | null;
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SRV' | 'CAA' | 'PTR' | 'SOA';
  name: string;
  value: string;
  ttl: number;
  priority: number | null;
  weight: number | null;
  port: number | null;
  caaFlag: number | null;
  caaTag: string | null;
  status: 'active' | 'pending' | 'error' | 'disabled';
  syncedAt: string | null;
  syncError: string | null;
  comment: string | null;
  metadata: Record<string, unknown> | null;
}

export interface DnsRecordsListResponse {
  records: DnsRecord[];
  zone: { id: string; syncedAt: string | null; syncError: string | null } | null;
}

export interface DnsRecordsMutationResponse {
  records: DnsRecord[];
}

export interface SyncDnsRecordsResponse {
  records: DnsRecord[];
  added: number;
  updated: number;
  removed: number;
}

export interface ScanDnsRecordsResponse {
  records: ScannedDnsRecord[];
}

export interface ImportDnsRecordsResponse {
  imported: number;
  skipped: number;
  failed: Array<{ record: ScannedDnsRecord; error: string }>;
}
