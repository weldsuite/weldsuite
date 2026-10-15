/**
 * Domain reads: the WeldHost domains connected to Mailpool, as the app shows
 * them. Connecting, refreshing DNS and disconnecting (Mailpool, the master
 * route table) are reach-api's.
 */

import { and, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import type { ReachDomain } from '@weldsuite/app-api-client/schemas/reach';
import { reachDomains, reachMailboxes } from '@weldsuite/db/schema';
import { reachError } from './errors';

export type DomainRow = typeof reachDomains.$inferSelect;

export function toDomainDto(row: DomainRow, mailboxCount: number): ReachDomain {
  return {
    id: row.id,
    hostDomainId: row.hostDomainId,
    name: row.name,
    mailpoolDomainId: row.mailpoolDomainId,
    status: row.status,
    dnsStatus: row.dnsStatus ?? null,
    dmarcPolicy: row.dmarcPolicy,
    connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
    lastError: row.lastError,
    mailboxCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Live mailboxes (any status but deleted) per domain id. */
export async function domainMailboxCounts(db: Database, domainIds: string[]): Promise<Map<string, number>> {
  if (domainIds.length === 0) return new Map();
  const rows = await db
    .select({ domainId: reachMailboxes.domainId, value: count() })
    .from(reachMailboxes)
    .where(
      and(
        inArray(reachMailboxes.domainId, domainIds),
        ne(reachMailboxes.status, 'deleted'),
        isNull(reachMailboxes.deletedAt),
      ),
    )
    .groupBy(reachMailboxes.domainId);
  return new Map(rows.map((r) => [r.domainId, r.value]));
}

export async function listDomains(db: Database): Promise<ReachDomain[]> {
  const rows = await db.select().from(reachDomains).orderBy(reachDomains.createdAt);
  const counts = await domainMailboxCounts(db, rows.map((r) => r.id));
  return rows.map((row) => toDomainDto(row, counts.get(row.id) ?? 0));
}

export async function requireDomain(db: Database, id: string): Promise<DomainRow> {
  const [row] = await db.select().from(reachDomains).where(eq(reachDomains.id, id)).limit(1);
  if (!row) throw reachError.notFound('Domain', id);
  return row;
}

export async function getDomainDto(db: Database, id: string): Promise<ReachDomain> {
  const row = await requireDomain(db, id);
  const counts = await domainMailboxCounts(db, [id]);
  return toDomainDto(row, counts.get(id) ?? 0);
}
