/**
 * DNS records service — pure functions backing `/api/dns-records/*`.
 *
 * Cloudflare is the source of truth. Every mutation calls
 * `syncZoneRecordsFromCloudflare` immediately after the CF call so a
 * partial failure or silent rejection can never leave the local table
 * stale.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '../db';
import {
  createDnsRecordInZone,
  updateDnsRecordInZone,
  deleteDnsRecordInZone,
} from '../lib/cloudflare-zones';
import { scanDomainRecords, type DnsRecord as PublicDnsRecord } from '../lib/dns-lookup';
import {
  syncZoneRecordsFromCloudflare,
  loadDnsRecordWithZone,
  isRecordLocked,
  getRecordLocks,
  addUserLock,
  removeUserLock,
  type SyncResult,
  type DnsRecordLock,
} from '../lib/host-dns-sync';

export type { DnsRecordLock };
export { isRecordLocked, getRecordLocks };

const { hostDnsRecords, hostDnsZones, hostDomains } = schema;

// ============================================================================
// Helpers
// ============================================================================

export interface RecordWriteInput {
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SRV' | 'CAA';
  name: string;
  value: string;
  ttl?: number;
  priority?: number;
  comment?: string;
}

export type CloudflareReady =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'no_cf_zone' }
  | { ok: false; reason: 'cf_misconfigured' }
  | {
      ok: true;
      domain: typeof schema.hostDomains.$inferSelect;
      zone: typeof schema.hostDnsZones.$inferSelect & { externalZoneId: string };
    };

export async function loadCloudflareZoneForDomain(
  db: Database,
  domainId: string,
): Promise<{
  domain: typeof schema.hostDomains.$inferSelect | null;
  zone: typeof schema.hostDnsZones.$inferSelect | null;
}> {
  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, domainId), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!domain) return { domain: null, zone: null };
  const [zone] = await db
    .select()
    .from(hostDnsZones)
    .where(and(eq(hostDnsZones.domainId, domainId), isNull(hostDnsZones.deletedAt)))
    .limit(1);
  return { domain, zone: zone ?? null };
}

export async function resolveCloudflareReady(
  db: Database,
  domainId: string,
  apiToken: string | undefined,
): Promise<CloudflareReady> {
  const { domain, zone } = await loadCloudflareZoneForDomain(db, domainId);
  if (!domain) return { ok: false, reason: 'not_found' };
  if (!zone || zone.provider !== 'cloudflare' || !zone.externalZoneId) {
    return { ok: false, reason: 'no_cf_zone' };
  }
  if (!apiToken) return { ok: false, reason: 'cf_misconfigured' };
  return {
    ok: true,
    domain,
    zone: zone as typeof schema.hostDnsZones.$inferSelect & { externalZoneId: string },
  };
}

export async function resolveCloudflareReadyByZone(
  db: Database,
  zoneId: string,
  apiToken: string | undefined,
): Promise<CloudflareReady> {
  const [zone] = await db
    .select()
    .from(hostDnsZones)
    .where(and(eq(hostDnsZones.id, zoneId), isNull(hostDnsZones.deletedAt)))
    .limit(1);
  if (!zone) return { ok: false, reason: 'not_found' };
  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, zone.domainId), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!domain) return { ok: false, reason: 'not_found' };
  if (zone.provider !== 'cloudflare' || !zone.externalZoneId) {
    return { ok: false, reason: 'no_cf_zone' };
  }
  if (!apiToken) return { ok: false, reason: 'cf_misconfigured' };
  return {
    ok: true,
    domain,
    zone: zone as typeof schema.hostDnsZones.$inferSelect & { externalZoneId: string },
  };
}

// ============================================================================
// List by zone (Cloudflare-first when zone is on CF and local table is empty/stale)
// ============================================================================

export interface ListByZoneResult {
  records: (typeof schema.hostDnsRecords.$inferSelect)[];
  zone: { id: string; syncedAt: Date | null; syncError: string | null } | null;
}

export async function listDnsRecordsByZone(
  db: Database,
  zoneId: string,
  apiToken: string | undefined,
): Promise<ListByZoneResult | null> {
  const [zone] = await db
    .select()
    .from(hostDnsZones)
    .where(and(eq(hostDnsZones.id, zoneId), isNull(hostDnsZones.deletedAt)))
    .limit(1);
  if (!zone) return null;

  let records = await db
    .select()
    .from(hostDnsRecords)
    .where(eq(hostDnsRecords.zoneId, zone.id));

  let syncedZone = {
    id: zone.id,
    syncedAt: zone.syncedAt,
    syncError: zone.syncError,
  };

  const isCloudflareZone =
    zone.provider === 'cloudflare' && !!zone.externalZoneId && !!apiToken;
  const needsSync = isCloudflareZone && (records.length === 0 || zone.syncedAt === null);
  if (needsSync && apiToken && zone.externalZoneId) {
    const sync = await syncZoneRecordsFromCloudflare(db, apiToken, zone as { id: string; externalZoneId: string });
    records = sync.records;
    const [refreshed] = await db
      .select()
      .from(hostDnsZones)
      .where(eq(hostDnsZones.id, zone.id))
      .limit(1);
    if (refreshed) {
      syncedZone = { id: refreshed.id, syncedAt: refreshed.syncedAt, syncError: refreshed.syncError };
    }
  }

  return { records, zone: syncedZone };
}

export async function listDnsRecordsByDomain(
  db: Database,
  domainId: string,
  apiToken: string | undefined,
): Promise<ListByZoneResult | null> {
  const { domain, zone } = await loadCloudflareZoneForDomain(db, domainId);
  if (!domain) return null;
  if (!zone) return { records: [], zone: null };
  return listDnsRecordsByZone(db, zone.id, apiToken);
}

// ============================================================================
// CRUD (CF-proxied)
// ============================================================================

export interface CfMutationResult {
  cfError: string | null;
  sync: SyncResult;
}

export async function createDnsRecord(
  db: Database,
  apiToken: string,
  zone: { id: string; externalZoneId: string },
  input: RecordWriteInput,
): Promise<CfMutationResult> {
  let cfError: string | null = null;
  try {
    await createDnsRecordInZone(apiToken, zone.externalZoneId, {
      type: input.type,
      name: input.name,
      content: input.value,
      ttl: input.ttl,
      priority: input.priority,
      comment: input.comment,
    });
  } catch (err) {
    cfError = err instanceof Error ? err.message : 'Cloudflare create failed';
    console.error('[dns-records.service] createDnsRecordInZone failed:', err);
  }
  const sync = await syncZoneRecordsFromCloudflare(db, apiToken, zone);
  return { cfError, sync };
}

export type UpdateOrDeleteResult =
  | CfMutationResult
  | { reason: 'not_found' }
  | { reason: 'no_cf_zone' }
  | { reason: 'locked'; reasons: string[] }
  | { reason: 'no_external_id' };

export async function updateDnsRecord(
  db: Database,
  apiToken: string,
  recordId: string,
  input: RecordWriteInput,
): Promise<UpdateOrDeleteResult> {
  const { record, zone } = await loadDnsRecordWithZone(db, recordId);
  if (!record || !zone) return { reason: 'not_found' };
  if (zone.provider !== 'cloudflare' || !zone.externalZoneId) return { reason: 'no_cf_zone' };
  if (isRecordLocked(record)) {
    return { reason: 'locked', reasons: getRecordLocks(record).map((l) => l.reason) };
  }
  if (!record.externalRecordId) return { reason: 'no_external_id' };

  let cfError: string | null = null;
  try {
    await updateDnsRecordInZone(apiToken, zone.externalZoneId, record.externalRecordId, {
      type: input.type,
      name: input.name,
      content: input.value,
      ttl: input.ttl,
      priority: input.priority,
      comment: input.comment,
    });
  } catch (err) {
    cfError = err instanceof Error ? err.message : 'Cloudflare update failed';
    console.error('[dns-records.service] updateDnsRecordInZone failed:', err);
  }
  const sync = await syncZoneRecordsFromCloudflare(db, apiToken, zone as { id: string; externalZoneId: string });
  return { cfError, sync };
}

export async function deleteDnsRecord(
  db: Database,
  apiToken: string,
  recordId: string,
): Promise<UpdateOrDeleteResult> {
  const { record, zone } = await loadDnsRecordWithZone(db, recordId);
  if (!record || !zone) return { reason: 'not_found' };
  if (zone.provider !== 'cloudflare' || !zone.externalZoneId) return { reason: 'no_cf_zone' };
  if (isRecordLocked(record)) {
    return { reason: 'locked', reasons: getRecordLocks(record).map((l) => l.reason) };
  }

  let cfError: string | null = null;
  if (record.externalRecordId) {
    try {
      await deleteDnsRecordInZone(apiToken, zone.externalZoneId, record.externalRecordId);
    } catch (err) {
      cfError = err instanceof Error ? err.message : 'Cloudflare delete failed';
      console.error('[dns-records.service] deleteDnsRecordInZone failed:', err);
    }
  }
  const sync = await syncZoneRecordsFromCloudflare(db, apiToken, zone as { id: string; externalZoneId: string });
  return { cfError, sync };
}

// ============================================================================
// Locks
// ============================================================================

export async function toggleUserLock(
  db: Database,
  recordId: string,
  params: { locked: boolean; reason: string },
): Promise<
  | { ok: false; reason: 'not_found' }
  | { ok: true; zoneId: string; records: (typeof schema.hostDnsRecords.$inferSelect)[] }
> {
  const { record, zone } = await loadDnsRecordWithZone(db, recordId);
  if (!record || !zone) return { ok: false, reason: 'not_found' };

  const nextMetadata = params.locked
    ? addUserLock(record.metadata as Record<string, unknown> | null, params.reason)
    : removeUserLock(record.metadata as Record<string, unknown> | null);

  await db
    .update(hostDnsRecords)
    .set({ metadata: nextMetadata, updatedAt: new Date() })
    .where(eq(hostDnsRecords.id, recordId));

  const records = await db
    .select()
    .from(hostDnsRecords)
    .where(eq(hostDnsRecords.zoneId, zone.id));
  return { ok: true, zoneId: zone.id, records };
}

// ============================================================================
// Public DNS scan + bulk import
// ============================================================================

function isImportable(domain: string, record: PublicDnsRecord): boolean {
  if (record.type === 'NS') return false;
  const verifyName = `_weldhost-verify.${domain}`.toLowerCase();
  if (record.type === 'TXT' && record.name.toLowerCase() === verifyName) return false;
  if (record.value.toLowerCase().endsWith('.ns.cloudflare.com')) return false;
  return true;
}

export async function scanDnsRecordsForDomain(
  db: Database,
  domainId: string,
): Promise<
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'no_cf_zone' }
  | { ok: false; reason: 'scan_failed' }
  | { ok: true; records: PublicDnsRecord[] }
> {
  const { domain, zone } = await loadCloudflareZoneForDomain(db, domainId);
  if (!domain) return { ok: false, reason: 'not_found' };
  if (!zone || zone.provider !== 'cloudflare') return { ok: false, reason: 'no_cf_zone' };

  let records: PublicDnsRecord[];
  try {
    records = await scanDomainRecords(domain.fullDomain);
  } catch (err) {
    console.error('[dns-records.service] DNS scan failed:', err);
    return { ok: false, reason: 'scan_failed' };
  }
  return { ok: true, records: records.filter((r) => isImportable(domain.fullDomain, r)) };
}

export async function importDnsRecords(
  db: Database,
  apiToken: string,
  domainId: string,
  records: PublicDnsRecord[],
): Promise<
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'no_cf_zone' }
  | { ok: false; reason: 'cf_misconfigured' }
  | { ok: true; imported: number; skipped: number; failed: Array<{ record: PublicDnsRecord; error: string }> }
> {
  const ready = await resolveCloudflareReady(db, domainId, apiToken);
  if (!ready.ok) return { ok: false, reason: ready.reason };

  let imported = 0;
  let skipped = 0;
  const failed: Array<{ record: PublicDnsRecord; error: string }> = [];

  for (const record of records) {
    if (!isImportable(ready.domain.fullDomain, record)) {
      skipped++;
      continue;
    }
    try {
      const res = await createDnsRecordInZone(apiToken, ready.zone.externalZoneId, {
        type: record.type,
        name: record.name,
        content: record.value,
        ttl: record.ttl,
        priority: record.priority,
      });
      if (res.created) imported++;
      else if (res.duplicate) skipped++;
    } catch (err) {
      failed.push({ record, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }

  // Final reconciliation so the local table reflects the imported set.
  await syncZoneRecordsFromCloudflare(db, apiToken, ready.zone);

  return { ok: true, imported, skipped, failed };
}

export async function syncRecordsFromCloudflare(
  db: Database,
  apiToken: string,
  zone: { id: string; externalZoneId: string },
) {
  return syncZoneRecordsFromCloudflare(db, apiToken, zone);
}
