/**
 * DNS zones service. Pure functions backing `/api/dns-zones/*`.
 *
 * Hand-rolled cursor pagination by createdAt+id, matching the shape used
 * by other app-api list services.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

const { hostDnsZones } = schema;

export interface ListDnsZonesParams {
  domainId?: string;
  status?: 'active' | 'pending' | 'disabled' | 'error';
  cursor?: string;
  limit?: number;
}

export async function listDnsZones(db: Database, params: ListDnsZonesParams) {
  const limit = Math.min(params.limit ?? 25, 100);
  const conditions = [isNull(hostDnsZones.deletedAt)];
  if (params.domainId) conditions.push(eq(hostDnsZones.domainId, params.domainId));
  if (params.status) conditions.push(eq(hostDnsZones.status, params.status));

  if (params.cursor) {
    const [cur] = await db
      .select({ createdAt: hostDnsZones.createdAt, id: hostDnsZones.id })
      .from(hostDnsZones)
      .where(eq(hostDnsZones.id, params.cursor))
      .limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${hostDnsZones.createdAt} < ${cur.createdAt} OR (${hostDnsZones.createdAt} = ${cur.createdAt} AND ${hostDnsZones.id} < ${cur.id}))`,
      );
    }
  }

  const filterConditions = params.cursor ? conditions.slice(0, -1) : conditions;

  const [rows, [countRow]] = await Promise.all([
    db
      .select()
      .from(hostDnsZones)
      .where(and(...conditions))
      .orderBy(desc(hostDnsZones.createdAt), desc(hostDnsZones.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(hostDnsZones)
      .where(and(...filterConditions)),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
  return { data, totalCount: countRow?.count ?? 0, hasMore, cursor };
}

export async function getDnsZone(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(hostDnsZones)
    .where(and(eq(hostDnsZones.id, id), isNull(hostDnsZones.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function getDnsZoneByDomain(db: Database, domainId: string) {
  const [row] = await db
    .select()
    .from(hostDnsZones)
    .where(and(eq(hostDnsZones.domainId, domainId), isNull(hostDnsZones.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function createDnsZone(
  db: Database,
  data: {
    domainId: string;
    name: string;
    status?: 'active' | 'pending' | 'disabled' | 'error';
    provider?: 'hetzner' | 'cloudflare' | 'route53' | 'custom';
    externalZoneId?: string | null;
    externalNameservers?: string[];
    defaultTtl?: number;
  },
) {
  const id = generateId('zone');
  await db.insert(hostDnsZones).values({
    id,
    domainId: data.domainId,
    name: data.name,
    status: data.status ?? 'pending',
    provider: data.provider ?? 'hetzner',
    externalZoneId: data.externalZoneId,
    externalNameservers: data.externalNameservers,
    defaultTtl: data.defaultTtl,
  });
  const [row] = await db.select().from(hostDnsZones).where(eq(hostDnsZones.id, id)).limit(1);
  return row!;
}

export async function updateDnsZone(
  db: Database,
  id: string,
  data: Record<string, unknown>,
) {
  const [existing] = await db
    .select()
    .from(hostDnsZones)
    .where(and(eq(hostDnsZones.id, id), isNull(hostDnsZones.deletedAt)))
    .limit(1);
  if (!existing) return null;

  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    update[k] = k === 'syncedAt' && typeof v === 'string' ? new Date(v) : v;
  }
  await db.update(hostDnsZones).set(update).where(eq(hostDnsZones.id, id));
  const [row] = await db.select().from(hostDnsZones).where(eq(hostDnsZones.id, id)).limit(1);
  return row!;
}

export async function deleteDnsZone(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(hostDnsZones)
    .where(and(eq(hostDnsZones.id, id), isNull(hostDnsZones.deletedAt)))
    .limit(1);
  if (!existing) return null;
  await db
    .update(hostDnsZones)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(hostDnsZones.id, id));
  return existing;
}
