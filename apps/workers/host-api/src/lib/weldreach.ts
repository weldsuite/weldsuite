/**
 * WeldReach hooks into WeldHost (docs/plans/weldreach.md, "WeldHost side").
 *
 * A WeldHost domain is "connected to WeldReach" while its tenant database has a
 * `reach_domains` row with `host_domain_id = domains.id` whose status is not
 * `disconnecting`. Mailpool then writes the mail records of that domain (MX,
 * SPF, DKIM, DMARC) into its Cloudflare zone, so while it is connected:
 *
 *  - the domain shows a "Used by WeldReach" badge (`usedByWeldReach`),
 *  - deleting it, issuing an auth code (transfer out) and changing its
 *    nameservers answer 409 `DOMAIN_IN_USE_BY_WELDREACH`,
 *  - the records Mailpool manages are marked `managedBy: 'weldreach'` and cannot
 *    be changed or deleted here (409 `DNS_RECORD_MANAGED_BY_WELDREACH`), and a
 *    second SPF or DMARC record cannot be added next to Mailpool's.
 *
 * Tenants whose migration for `reach_domains` has not run yet simply have no
 * connected domains.
 */

import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Context } from 'hono';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { isMissingTable } from '@weldsuite/worker-kit/pg-errors';

const { reachDomains, hostDnsZones } = schema;

export const WELDREACH_MANAGED_BY = 'weldreach' as const;
export type DnsRecordManagedBy = typeof WELDREACH_MANAGED_BY | null;

export const DOMAIN_IN_USE_BY_WELDREACH = 'DOMAIN_IN_USE_BY_WELDREACH';
export const DNS_RECORD_MANAGED_BY_WELDREACH = 'DNS_RECORD_MANAGED_BY_WELDREACH';

const DOMAIN_IN_USE_MESSAGE = 'Disconnect this domain in WeldReach first.';
const DNS_RECORD_MANAGED_MESSAGE =
  'This record is managed by WeldReach. Disconnect the domain in WeldReach first.';

/** 409 for an action that is blocked while the domain is connected to WeldReach. */
export function domainInUseResponse(c: Context): Response {
  return c.json({ error: { code: DOMAIN_IN_USE_BY_WELDREACH, message: DOMAIN_IN_USE_MESSAGE } }, 409);
}

/** 409 for a DNS record WeldReach manages (or would be duplicated by). */
export function recordManagedResponse(c: Context): Response {
  return c.json({ error: { code: DNS_RECORD_MANAGED_BY_WELDREACH, message: DNS_RECORD_MANAGED_MESSAGE } }, 409);
}

// ============================================================================
// Connected domains
// ============================================================================

/** Connected = a `reach_domains` row that is not already being disconnected. */
const isConnected = ne(reachDomains.status, 'disconnecting');

async function orNone<T>(fallback: T, query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (err) {
    if (isMissingTable(err)) return fallback;
    throw err;
  }
}

/** The ids, among `domainIds`, of the domains connected to WeldReach. One query, for list pages. */
export async function connectedWeldReachDomainIds(db: Database, domainIds: string[]): Promise<Set<string>> {
  if (domainIds.length === 0) return new Set();
  return orNone(new Set<string>(), async () => {
    const rows = await db
      .select({ hostDomainId: reachDomains.hostDomainId })
      .from(reachDomains)
      .where(and(inArray(reachDomains.hostDomainId, domainIds), isConnected));
    return new Set(rows.map((row) => row.hostDomainId));
  });
}

export async function isDomainUsedByWeldReach(db: Database, domainId: string): Promise<boolean> {
  return (await connectedWeldReachDomainIds(db, [domainId])).has(domainId);
}

/** Same check by name, for a record that only carries the domain name (outgoing transfers). */
export async function isDomainNameUsedByWeldReach(db: Database, domainName: string): Promise<boolean> {
  return orNone(false, async () => {
    const [row] = await db
      .select({ id: reachDomains.id })
      .from(reachDomains)
      .where(and(eq(reachDomains.name, domainName.trim().toLowerCase()), isConnected))
      .limit(1);
    return Boolean(row);
  });
}

/** The name of the zone's domain when that domain is connected to WeldReach, else null. */
export async function weldReachDomainNameForZone(db: Database, zoneId: string): Promise<string | null> {
  return orNone<string | null>(null, async () => {
    const [row] = await db
      .select({ name: hostDnsZones.name, reachDomainId: reachDomains.id })
      .from(hostDnsZones)
      .leftJoin(reachDomains, and(eq(reachDomains.hostDomainId, hostDnsZones.domainId), isConnected))
      .where(eq(hostDnsZones.id, zoneId))
      .limit(1);
    return row?.reachDomainId ? row.name : null;
  });
}

// ============================================================================
// Which records are Mailpool's
// ============================================================================

function stripTrailingDot(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '');
}

/** Absolute, lower-case name of a record: `@`, an empty name and relative names resolve against the domain. */
export function toFqdn(name: string, domainName: string): string {
  const domain = stripTrailingDot(domainName);
  const record = stripTrailingDot(name);
  if (record === '' || record === '@' || record === domain) return domain;
  return record.endsWith(`.${domain}`) ? record : `${record}.${domain}`;
}

/** TXT content as Cloudflare returns it is wrapped in quotes. */
function isSpfValue(value: string): boolean {
  return /^v=spf1(\s|$)/i.test(value.trim().replace(/^"/, '').trim());
}

interface RecordShape {
  type: string;
  name: string;
  value: string;
}

/**
 * The records Mailpool writes for a connected domain: MX on the apex, the SPF
 * TXT on the apex, DKIM TXT on `<selector>._domainkey.<domain>` and the DMARC
 * TXT on `_dmarc.<domain>`.
 */
export function isWeldReachManagedRecord(domainName: string, record: RecordShape): boolean {
  const domain = stripTrailingDot(domainName);
  const name = toFqdn(record.name, domain);
  const type = record.type.toUpperCase();

  if (type === 'MX') return name === domain;
  if (type !== 'TXT') return false;
  if (name === domain) return isSpfValue(record.value);
  if (name === `_dmarc.${domain}`) return true;
  const dkimSuffix = `._domainkey.${domain}`;
  return name.endsWith(dkimSuffix) && name.length > dkimSuffix.length;
}

/**
 * Records that must exist once: a second SPF on the apex or a second DMARC
 * invalidates the one WeldReach wrote, so neither can be added (or an existing
 * record turned into one) while the domain is connected.
 */
export function duplicatesWeldReachRecord(domainName: string, record: RecordShape): boolean {
  if (record.type.toUpperCase() !== 'TXT') return false;
  const domain = stripTrailingDot(domainName);
  const name = toFqdn(record.name, domain);
  return (name === domain && isSpfValue(record.value)) || name === `_dmarc.${domain}`;
}

/**
 * Add `managedBy` to the records of one zone. A record of a connected domain
 * that Mailpool manages gets `'weldreach'`, every other record `null`.
 */
export async function markWeldReachRecords<R extends RecordShape & { zoneId: string }>(
  db: Database,
  records: R[],
): Promise<Array<R & { managedBy: DnsRecordManagedBy }>> {
  const first = records[0];
  if (!first) return [];
  const domainName = await weldReachDomainNameForZone(db, first.zoneId);
  return records.map((record) => ({
    ...record,
    managedBy: domainName && isWeldReachManagedRecord(domainName, record) ? WELDREACH_MANAGED_BY : null,
  }));
}

// ============================================================================
// Nameserver changes
// ============================================================================

function sameNameservers(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const left = [...(a ?? [])].map(stripTrailingDot).sort((x, y) => x.localeCompare(y));
  const right = [...(b ?? [])].map(stripTrailingDot).sort((x, y) => x.localeCompare(y));
  return left.length === right.length && left.every((ns, index) => ns === right[index]);
}

/**
 * Whether a domain PATCH changes the nameservers. A form that sends the unchanged
 * values back along with another edit is not a change.
 */
export function changesNameservers(
  existing: { nameservers?: string[] | null; customNameservers?: boolean | null },
  patch: { nameservers?: string[]; customNameservers?: boolean },
): boolean {
  if (patch.nameservers !== undefined && !sameNameservers(existing.nameservers, patch.nameservers)) return true;
  return patch.customNameservers !== undefined && patch.customNameservers !== Boolean(existing.customNameservers);
}

/**
 * Whether a DNS zone PATCH points the zone somewhere else (provider, Cloudflare
 * zone or nameservers), which changes the nameservers of its domain.
 */
export function changesZoneRouting(
  existing: { provider?: string | null; externalZoneId?: string | null; externalNameservers?: string[] | null },
  patch: { provider?: string; externalZoneId?: string | null; externalNameservers?: string[] },
): boolean {
  if (patch.provider !== undefined && patch.provider !== existing.provider) return true;
  if (patch.externalZoneId !== undefined && (patch.externalZoneId ?? null) !== (existing.externalZoneId ?? null)) {
    return true;
  }
  return (
    patch.externalNameservers !== undefined &&
    !sameNameservers(existing.externalNameservers, patch.externalNameservers)
  );
}
