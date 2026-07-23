/**
 * Email forwards service — pure functions backing /api/email-forwards/*.
 *
 * Email forwards are stored rules — Cloudflare Email Routing provisioning
 * lives in the WeldMail module and is not part of this surface.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

const { hostEmailForwards } = schema;

export interface ListEmailForwardsParams {
  domainId?: string;
  enabled?: boolean;
  status?: typeof schema.hostEmailForwards.$inferSelect['status'];
  cursor?: string;
  limit?: number;
}

export async function listEmailForwards(db: Database, params: ListEmailForwardsParams) {
  const limit = Math.min(params.limit ?? 25, 100);
  const conditions = [isNull(hostEmailForwards.deletedAt)];
  if (params.domainId) conditions.push(eq(hostEmailForwards.domainId, params.domainId));
  if (params.enabled !== undefined) conditions.push(eq(hostEmailForwards.enabled, params.enabled));
  if (params.status) conditions.push(eq(hostEmailForwards.status, params.status));

  if (params.cursor) {
    const [cur] = await db
      .select({ createdAt: hostEmailForwards.createdAt, id: hostEmailForwards.id })
      .from(hostEmailForwards)
      .where(eq(hostEmailForwards.id, params.cursor))
      .limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${hostEmailForwards.createdAt} < ${cur.createdAt} OR (${hostEmailForwards.createdAt} = ${cur.createdAt} AND ${hostEmailForwards.id} < ${cur.id}))`,
      );
    }
  }

  const filterConditions = params.cursor ? conditions.slice(0, -1) : conditions;

  const [rows, [countRow]] = await Promise.all([
    db
      .select()
      .from(hostEmailForwards)
      .where(and(...conditions))
      .orderBy(desc(hostEmailForwards.createdAt), desc(hostEmailForwards.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(hostEmailForwards)
      .where(and(...filterConditions)),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
  return { data, totalCount: countRow?.count ?? 0, hasMore, cursor };
}

export async function getEmailForward(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(hostEmailForwards)
    .where(and(eq(hostEmailForwards.id, id), isNull(hostEmailForwards.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function createEmailForward(
  db: Database,
  data: {
    domainId: string;
    source: string;
    destination: string;
    additionalDestinations?: string[];
    enabled?: boolean;
    catchAll?: boolean;
    wildcard?: boolean;
    status?: 'active' | 'pending' | 'disabled' | 'error';
  },
) {
  const id = generateId('efwd');
  await db.insert(hostEmailForwards).values({
    id,
    domainId: data.domainId,
    source: data.source,
    destination: data.destination,
    additionalDestinations: data.additionalDestinations,
    enabled: data.enabled ?? true,
    catchAll: data.catchAll ?? false,
    wildcard: data.wildcard ?? false,
    status: data.status ?? 'active',
  });
  const [row] = await db
    .select()
    .from(hostEmailForwards)
    .where(eq(hostEmailForwards.id, id))
    .limit(1);
  return row!;
}

export async function updateEmailForward(
  db: Database,
  id: string,
  data: Record<string, unknown>,
) {
  const [existing] = await db
    .select()
    .from(hostEmailForwards)
    .where(and(eq(hostEmailForwards.id, id), isNull(hostEmailForwards.deletedAt)))
    .limit(1);
  if (!existing) return null;
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) update[k] = v;
  }
  await db.update(hostEmailForwards).set(update).where(eq(hostEmailForwards.id, id));
  const [row] = await db
    .select()
    .from(hostEmailForwards)
    .where(eq(hostEmailForwards.id, id))
    .limit(1);
  return row!;
}

export async function deleteEmailForward(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(hostEmailForwards)
    .where(and(eq(hostEmailForwards.id, id), isNull(hostEmailForwards.deletedAt)))
    .limit(1);
  if (!existing) return null;
  await db
    .update(hostEmailForwards)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(hostEmailForwards.id, id));
  return existing;
}
