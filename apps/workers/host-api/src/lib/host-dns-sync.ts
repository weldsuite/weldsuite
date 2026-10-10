/**
 * WeldHost DNS sync — pulls the live record set from a Cloudflare zone and
 * reconciles the local `hostDnsRecords` table so it mirrors reality.
 *
 * Cloudflare is the source of truth. Any platform-side mutation (create /
 * update / delete) calls this immediately afterwards so a partial failure or
 * silent CF rejection can never leave our DB stale.
 *
 * Ported from `apps/api-worker/src/lib/host-dns-sync.ts`.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  listDnsRecordsInZone,
  CloudflareZoneError,
  type CloudflareDnsRecord,
} from '@weldsuite/cloudflare-zones';

type LocalRecordType = (typeof schema.hostDnsRecords.$inferSelect)['type'];

export interface SyncResult {
  ok: boolean;
  records: (typeof schema.hostDnsRecords.$inferSelect)[];
  error?: string;
  added: number;
  updated: number;
  removed: number;
}

const RECORD_TYPES: ReadonlyArray<LocalRecordType> = [
  'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'PTR', 'SOA',
];

/**
 * `null` arrives for record types the zones client cannot edit (SOA, HTTPS, …);
 * those are skipped by the caller rather than synced.
 */
function mapType(t: string | null): LocalRecordType | null {
  if (!t) return null;
  return (RECORD_TYPES as readonly string[]).includes(t) ? (t as LocalRecordType) : null;
}

interface MappedRecord {
  externalRecordId: string;
  type: LocalRecordType;
  name: string;
  value: string;
  ttl: number;
  priority: number | null;
  weight: number | null;
  port: number | null;
  caaFlag: number | null;
  caaTag: string | null;
  comment: string | null;
}

function mapCloudflareRecord(r: CloudflareDnsRecord): MappedRecord | null {
  const type = mapType(r.type);
  if (!type) return null;
  return {
    externalRecordId: r.id,
    type,
    name: r.name,
    value: r.content,
    ttl: r.ttl ?? 3600,
    priority: r.priority ?? r.data?.priority ?? null,
    weight: r.data?.weight ?? null,
    port: r.data?.port ?? null,
    caaFlag: r.data?.flags ?? null,
    caaTag: r.data?.tag ?? null,
    comment: r.comment ?? null,
  };
}

type LocalRecord = typeof schema.hostDnsRecords.$inferSelect;

/**
 * Cloudflare list failed: record the error on the zone and hand back the
 * (unchanged) local record set.
 */
async function failListSync(
  db: Database,
  zone: { id: string },
  err: unknown,
): Promise<SyncResult> {
  const { hostDnsRecords, hostDnsZones } = schema;
  const message =
    err instanceof CloudflareZoneError || err instanceof Error ? err.message : 'Cloudflare list records failed';
  console.error('[host-dns-sync] listDnsRecordsInZone failed:', err);
  await db
    .update(hostDnsZones)
    .set({ syncError: message.slice(0, 1000), syncedAt: new Date(), updatedAt: new Date() })
    .where(eq(hostDnsZones.id, zone.id));

  const records = await db
    .select()
    .from(hostDnsRecords)
    .where(eq(hostDnsRecords.zoneId, zone.id));
  return { ok: false, records, added: 0, updated: 0, removed: 0, error: message };
}

function hasRecordDrift(local: LocalRecord, m: MappedRecord): boolean {
  return (
    local.type !== m.type ||
    local.name !== m.name ||
    local.value !== m.value ||
    local.ttl !== m.ttl ||
    (local.priority ?? null) !== (m.priority ?? null) ||
    (local.weight ?? null) !== (m.weight ?? null) ||
    (local.port ?? null) !== (m.port ?? null) ||
    (local.caaFlag ?? null) !== (m.caaFlag ?? null) ||
    (local.caaTag ?? null) !== (m.caaTag ?? null) ||
    (local.comment ?? null) !== (m.comment ?? null) ||
    local.status !== 'active' ||
    local.syncError !== null
  );
}

/** Insert, update or touch one local row so it mirrors the Cloudflare record. */
async function reconcileRecord(
  db: Database,
  zoneId: string,
  m: MappedRecord,
  local: LocalRecord | undefined,
  now: Date,
): Promise<'added' | 'updated' | 'unchanged'> {
  const { hostDnsRecords } = schema;
  if (!local) {
    await db.insert(hostDnsRecords).values({
      id: generateId('dnsrec'),
      zoneId,
      externalRecordId: m.externalRecordId,
      type: m.type,
      name: m.name,
      value: m.value,
      ttl: m.ttl,
      priority: m.priority,
      weight: m.weight,
      port: m.port,
      caaFlag: m.caaFlag,
      caaTag: m.caaTag,
      comment: m.comment,
      status: 'active',
      syncedAt: now,
      syncError: null,
    });
    return 'added';
  }
  if (hasRecordDrift(local, m)) {
    // Preserve metadata (including locks) — local state with no CF counterpart.
    await db
      .update(hostDnsRecords)
      .set({
        type: m.type,
        name: m.name,
        value: m.value,
        ttl: m.ttl,
        priority: m.priority,
        weight: m.weight,
        port: m.port,
        caaFlag: m.caaFlag,
        caaTag: m.caaTag,
        comment: m.comment,
        status: 'active',
        syncedAt: now,
        syncError: null,
        updatedAt: now,
      })
      .where(eq(hostDnsRecords.id, local.id));
    return 'updated';
  }
  await db
    .update(hostDnsRecords)
    .set({ syncedAt: now })
    .where(eq(hostDnsRecords.id, local.id));
  return 'unchanged';
}

/** Delete local rows Cloudflare no longer has (or that never had an external id). */
async function pruneStaleRecords(
  db: Database,
  existing: LocalRecord[],
  existingWithoutExtId: LocalRecord[],
  seenExtIds: Set<string>,
): Promise<number> {
  const { hostDnsRecords } = schema;
  const staleIds = [
    ...existing
      .filter((row) => row.externalRecordId && !seenExtIds.has(row.externalRecordId))
      .map((row) => row.id),
    ...existingWithoutExtId.map((row) => row.id),
  ];
  if (staleIds.length === 0) return 0;
  await db.delete(hostDnsRecords).where(inArray(hostDnsRecords.id, staleIds));
  return staleIds.length;
}

/** Reconcile system locks (WeldMail deps etc.); failures are logged, not thrown. */
async function reconcileSystemLocks(db: Database, zoneId: string): Promise<void> {
  const { hostDnsZones } = schema;
  try {
    const zoneName = (await db
      .select({ name: hostDnsZones.name })
      .from(hostDnsZones)
      .where(eq(hostDnsZones.id, zoneId))
      .limit(1))[0]?.name;
    if (zoneName) {
      await detectSystemLocksForZone(db, { id: zoneId, name: zoneName });
    }
  } catch (err) {
    console.error('[host-dns-sync] detectSystemLocksForZone failed:', err);
  }
}

export async function syncZoneRecordsFromCloudflare(
  db: Database,
  apiToken: string,
  zone: { id: string; externalZoneId: string | null },
): Promise<SyncResult> {
  const { hostDnsRecords, hostDnsZones } = schema;

  if (!zone.externalZoneId) {
    return { ok: false, records: [], added: 0, updated: 0, removed: 0, error: 'Zone has no Cloudflare zone id' };
  }

  let cfRecords: CloudflareDnsRecord[];
  try {
    cfRecords = await listDnsRecordsInZone(apiToken, zone.externalZoneId);
  } catch (err) {
    return failListSync(db, zone, err);
  }

  const existing = await db
    .select()
    .from(hostDnsRecords)
    .where(eq(hostDnsRecords.zoneId, zone.id));

  const existingByExtId = new Map<string, typeof existing[number]>();
  const existingWithoutExtId: typeof existing = [];
  for (const row of existing) {
    if (row.externalRecordId) existingByExtId.set(row.externalRecordId, row);
    else existingWithoutExtId.push(row);
  }

  const cfMapped = cfRecords
    .map(mapCloudflareRecord)
    .filter((r): r is MappedRecord => r !== null);

  const seenExtIds = new Set<string>();
  let added = 0;
  let updated = 0;
  const now = new Date();

  for (const m of cfMapped) {
    seenExtIds.add(m.externalRecordId);
    const outcome = await reconcileRecord(db, zone.id, m, existingByExtId.get(m.externalRecordId), now);
    if (outcome === 'added') added++;
    else if (outcome === 'updated') updated++;
  }

  const removed = await pruneStaleRecords(db, existing, existingWithoutExtId, seenExtIds);

  await db
    .update(hostDnsZones)
    .set({
      syncedAt: now,
      syncError: null,
      recordCount: cfMapped.length,
      updatedAt: now,
    })
    .where(eq(hostDnsZones.id, zone.id));

  await reconcileSystemLocks(db, zone.id);

  const fresh = await db
    .select()
    .from(hostDnsRecords)
    .where(eq(hostDnsRecords.zoneId, zone.id));

  return { ok: true, records: fresh, added, updated, removed };
}

// ============================================================================
// Record locks — see api-worker/host-dns-sync for the full design rationale.
// ============================================================================

export interface DnsRecordLock {
  source: string;
  sourceId?: string;
  purpose?: string;
  reason: string;
  lockedAt: string;
}

type RecordWithMetadata = { metadata?: Record<string, unknown> | null };

export function getRecordLocks(record: RecordWithMetadata): DnsRecordLock[] {
  const raw = record.metadata?.locks;
  if (!Array.isArray(raw)) return [];
  return raw.filter((l): l is DnsRecordLock =>
    typeof l === 'object' && l !== null &&
    typeof (l as { source?: unknown }).source === 'string' &&
    typeof (l as { reason?: unknown }).reason === 'string',
  );
}

export function isRecordLocked(record: RecordWithMetadata): boolean {
  return getRecordLocks(record).length > 0;
}

export function hasSystemLock(record: RecordWithMetadata): boolean {
  return getRecordLocks(record).some((l) => l.source !== 'user');
}

function setLocksOnMetadata(
  metadata: Record<string, unknown> | null | undefined,
  locks: DnsRecordLock[],
): Record<string, unknown> {
  const next = { ...(metadata as Record<string, unknown> | null) };
  if (locks.length === 0) delete next.locks;
  else next.locks = locks;
  return next;
}

export function addUserLock(
  metadata: Record<string, unknown> | null | undefined,
  reason: string,
): Record<string, unknown> {
  const existing = getRecordLocks({ metadata });
  const filtered = existing.filter((l) => l.source !== 'user');
  filtered.push({ source: 'user', reason, lockedAt: new Date().toISOString() });
  return setLocksOnMetadata(metadata, filtered);
}

export function removeUserLock(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const existing = getRecordLocks({ metadata });
  return setLocksOnMetadata(metadata, existing.filter((l) => l.source !== 'user'));
}

function normalizeRecordName(n: string): string {
  return n.toLowerCase().replace(/\.$/, '');
}

function lockKey(type: unknown, name: string): string {
  return `${String(type).toUpperCase()}|${normalizeRecordName(name)}`;
}

function weldmailLockReason(purpose: string, domainName: string): string {
  switch (purpose) {
    case 'mx':
      return `Required by WeldMail for inbound email on ${domainName}. Removing it will break email delivery.`;
    case 'spf':
      return `Required by WeldMail (SPF) on ${domainName}. Removing it will cause outbound mail to be marked as spam.`;
    case 'dkim':
      return `Required by WeldMail (DKIM) on ${domainName}. Removing it will cause outbound mail to fail authentication.`;
    case 'dmarc':
      return `Required by WeldMail (DMARC) on ${domainName}. Removing it weakens email authentication.`;
    case 'verification':
      return `Required by WeldMail to verify ownership of ${domainName}.`;
    default:
      return `Required by WeldMail (${purpose}) on ${domainName}.`;
  }
}

interface MailDomainRow {
  id: string;
  domainName: string;
  dnsRecords: Array<{ type: string; name: string; purpose?: string; value: string }> | null;
}

/** Locks WeldMail expects on the zone, keyed by `TYPE|normalized-name`. */
function buildExpectedMailLocks(mailDomainsForZone: MailDomainRow[]): Map<string, DnsRecordLock[]> {
  const expectedByKey = new Map<string, DnsRecordLock[]>();
  for (const md of mailDomainsForZone) {
    const dnsRecords = Array.isArray(md.dnsRecords) ? md.dnsRecords : [];
    for (const r of dnsRecords) {
      if (!r.purpose) continue;
      const key = lockKey(r.type, r.name);
      const lock: DnsRecordLock = {
        source: 'weldmail',
        sourceId: md.id,
        purpose: r.purpose,
        reason: weldmailLockReason(r.purpose, md.domainName),
        lockedAt: new Date().toISOString(),
      };
      const list = expectedByKey.get(key) ?? [];
      list.push(lock);
      expectedByKey.set(key, list);
    }
  }
  return expectedByKey;
}

function isSameLock(a: DnsRecordLock, b: DnsRecordLock): boolean {
  return a.source === b.source && a.sourceId === b.sourceId && a.purpose === b.purpose;
}

function isSameLockSet(current: DnsRecordLock[], expected: DnsRecordLock[]): boolean {
  return (
    current.length === expected.length &&
    expected.every((e) => current.some((c) => isSameLock(c, e)))
  );
}

/** Expected locks, keeping the original `lockedAt` of locks already present. */
function mergeSystemLocks(expected: DnsRecordLock[], current: DnsRecordLock[]): DnsRecordLock[] {
  return expected.map((e) => {
    const existing = current.find((c) => isSameLock(c, e));
    return existing ? { ...e, lockedAt: existing.lockedAt } : e;
  });
}

export async function detectSystemLocksForZone(
  db: Database,
  zone: { id: string; name: string },
): Promise<{ locked: number; unlocked: number }> {
  const { hostDnsRecords, mailDomains } = schema;

  const records = await db
    .select()
    .from(hostDnsRecords)
    .where(eq(hostDnsRecords.zoneId, zone.id));

  const mailDomainsForZone = await db
    .select()
    .from(mailDomains)
    .where(eq(mailDomains.domainName, zone.name));

  const expectedByKey = buildExpectedMailLocks(mailDomainsForZone as MailDomainRow[]);

  let locked = 0;
  let unlocked = 0;

  for (const rec of records) {
    const expectedSystemLocks = expectedByKey.get(lockKey(rec.type, rec.name)) ?? [];
    const currentLocks = getRecordLocks(rec);
    const userLocks = currentLocks.filter((l) => l.source === 'user');
    const currentSystemLocks = currentLocks.filter((l) => l.source !== 'user');

    if (isSameLockSet(currentSystemLocks, expectedSystemLocks)) continue;

    const mergedSystemLocks = mergeSystemLocks(expectedSystemLocks, currentSystemLocks);

    const nextLocks = [...userLocks, ...mergedSystemLocks];
    const nextMetadata = setLocksOnMetadata(rec.metadata as Record<string, unknown> | null, nextLocks);

    await db
      .update(hostDnsRecords)
      .set({ metadata: nextMetadata, updatedAt: new Date() })
      .where(eq(hostDnsRecords.id, rec.id));

    if (mergedSystemLocks.length > currentSystemLocks.length) locked++;
    else if (mergedSystemLocks.length < currentSystemLocks.length) unlocked++;
  }

  return { locked, unlocked };
}

export async function loadDnsRecordWithZone(db: Database, recordId: string) {
  const { hostDnsRecords, hostDnsZones } = schema;
  const [record] = await db
    .select()
    .from(hostDnsRecords)
    .where(eq(hostDnsRecords.id, recordId))
    .limit(1);
  if (!record) return { record: null as null, zone: null as null };
  const [zone] = await db
    .select()
    .from(hostDnsZones)
    .where(and(eq(hostDnsZones.id, record.zoneId)))
    .limit(1);
  return { record, zone: zone ?? null };
}
