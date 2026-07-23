/**
 * Domain transfers service — pure functions backing /api/domain-transfers/*.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

const { hostDomainTransfers } = schema;

export interface ListDomainTransfersParams {
  domainId?: string;
  status?: typeof schema.hostDomainTransfers.$inferSelect['status'];
  type?: typeof schema.hostDomainTransfers.$inferSelect['type'];
  cursor?: string;
  limit?: number;
}

export async function listDomainTransfers(db: Database, params: ListDomainTransfersParams) {
  const limit = Math.min(params.limit ?? 25, 100);
  const conditions = [] as any[];
  if (params.domainId) conditions.push(eq(hostDomainTransfers.domainId, params.domainId));
  if (params.status) conditions.push(eq(hostDomainTransfers.status, params.status));
  if (params.type) conditions.push(eq(hostDomainTransfers.type, params.type));
  if (params.cursor) {
    const [cur] = await db
      .select({ createdAt: hostDomainTransfers.createdAt, id: hostDomainTransfers.id })
      .from(hostDomainTransfers)
      .where(eq(hostDomainTransfers.id, params.cursor))
      .limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${hostDomainTransfers.createdAt} < ${cur.createdAt} OR (${hostDomainTransfers.createdAt} = ${cur.createdAt} AND ${hostDomainTransfers.id} < ${cur.id}))`,
      );
    }
  }

  const filterConditions = params.cursor ? conditions.slice(0, -1) : conditions;

  const [rows, [countRow]] = await Promise.all([
    db
      .select()
      .from(hostDomainTransfers)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(hostDomainTransfers.createdAt), desc(hostDomainTransfers.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(hostDomainTransfers)
      .where(filterConditions.length ? and(...filterConditions) : undefined),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
  return { data, totalCount: countRow?.count ?? 0, hasMore, cursor };
}

export async function getDomainTransfer(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(hostDomainTransfers)
    .where(eq(hostDomainTransfers.id, id))
    .limit(1);
  return row ?? null;
}

export async function createDomainTransfer(
  db: Database,
  data: {
    domainId?: string | null;
    domainName: string;
    type: 'incoming' | 'outgoing';
    authCode?: string;
    fromRegistrar?: string;
    toRegistrar?: string;
  },
) {
  const id = generateId('txfr');
  await db.insert(hostDomainTransfers).values({
    id,
    domainId: data.domainId,
    domainName: data.domainName,
    type: data.type,
    status: 'pending',
    authCode: data.authCode,
    fromRegistrar: data.fromRegistrar,
    toRegistrar: data.toRegistrar,
  });
  const [row] = await db
    .select()
    .from(hostDomainTransfers)
    .where(eq(hostDomainTransfers.id, id))
    .limit(1);
  return row!;
}

export async function completeDomainTransfer(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(hostDomainTransfers)
    .where(eq(hostDomainTransfers.id, id))
    .limit(1);
  if (!existing) return null;
  await db
    .update(hostDomainTransfers)
    .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
    .where(eq(hostDomainTransfers.id, id));
  const [row] = await db
    .select()
    .from(hostDomainTransfers)
    .where(eq(hostDomainTransfers.id, id))
    .limit(1);
  return row!;
}

export async function failDomainTransfer(db: Database, id: string, reason: string) {
  const [existing] = await db
    .select()
    .from(hostDomainTransfers)
    .where(eq(hostDomainTransfers.id, id))
    .limit(1);
  if (!existing) return null;
  await db
    .update(hostDomainTransfers)
    .set({ status: 'failed', failureReason: reason, updatedAt: new Date() })
    .where(eq(hostDomainTransfers.id, id));
  const [row] = await db
    .select()
    .from(hostDomainTransfers)
    .where(eq(hostDomainTransfers.id, id))
    .limit(1);
  return row!;
}
