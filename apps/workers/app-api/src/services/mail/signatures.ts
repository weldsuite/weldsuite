/**
 * Mail signature service.
 *
 * Signatures are workspace-level — they aren't tied to a single mail
 * account, but can be assigned to one or more accounts/users via the
 * `accountIds` / `userIds` JSONB arrays. Setting `isDefault = true`
 * unsets the previous default in a single transaction-of-one (the table
 * has no `account_id` column, so default is workspace-wide).
 */

import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../db';
import type { Database } from '../../db';
import { generateId } from '../../lib/id';

const { mailSignatures } = schema;

export interface ListSignaturesFilters {
  type?: 'personal' | 'company' | 'department';
  limit?: number;
  cursor?: string;
}

export async function listSignatures(db: Database, filters: ListSignaturesFilters) {
  const limit = Math.min(filters.limit ?? 50, 100);
  const conditions: SQL[] = [isNull(mailSignatures.deletedAt)!];
  if (filters.type) conditions.push(eq(mailSignatures.type, filters.type));

  if (filters.cursor) {
    const [cur] = await db
      .select({ createdAt: mailSignatures.createdAt, id: mailSignatures.id })
      .from(mailSignatures)
      .where(eq(mailSignatures.id, filters.cursor))
      .limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${mailSignatures.createdAt} < ${cur.createdAt} OR (${mailSignatures.createdAt} = ${cur.createdAt} AND ${mailSignatures.id} < ${cur.id}))`,
      );
    }
  }

  const where = and(...conditions);
  const countWhere = and(...(filters.cursor ? conditions.slice(0, -1) : conditions));

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(mailSignatures)
      .where(where)
      .orderBy(desc(mailSignatures.createdAt), desc(mailSignatures.id))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(mailSignatures).where(countWhere),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
  return { data, hasMore, cursor, totalCount: Number(countRes[0]?.count ?? 0) };
}

export async function getSignature(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(mailSignatures)
    .where(and(eq(mailSignatures.id, id), isNull(mailSignatures.deletedAt)))
    .limit(1);
  return row ?? null;
}

export interface SignatureInput {
  name: string;
  content: string;
  isDefault?: boolean;
  type?: 'personal' | 'company' | 'department';
  accountIds?: string[];
  userIds?: string[];
  includeInReplies?: boolean;
  includeInForwards?: boolean;
  position?: 'above' | 'below';
  tags?: string[];
}

export async function createSignature(db: Database, data: SignatureInput) {
  if (data.isDefault) {
    await db
      .update(mailSignatures)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(isNull(mailSignatures.deletedAt));
  }
  const id = generateId('msig');
  const now = new Date();
  await db.insert(mailSignatures).values({
    id,
    ...data,
    isDefault: data.isDefault ?? false,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(mailSignatures).where(eq(mailSignatures.id, id));
  return row!;
}

export async function updateSignature(db: Database, id: string, data: Partial<SignatureInput>) {
  const [existing] = await db
    .select()
    .from(mailSignatures)
    .where(and(eq(mailSignatures.id, id), isNull(mailSignatures.deletedAt)))
    .limit(1);
  if (!existing) return null;

  if (data.isDefault) {
    await db
      .update(mailSignatures)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(isNull(mailSignatures.deletedAt));
  }
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v;
  await db
    .update(mailSignatures)
    .set(patch as typeof mailSignatures.$inferInsert)
    .where(eq(mailSignatures.id, id));
  const [after] = await db.select().from(mailSignatures).where(eq(mailSignatures.id, id));
  return { before: existing, after: after! };
}

export async function softDeleteSignature(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(mailSignatures)
    .where(and(eq(mailSignatures.id, id), isNull(mailSignatures.deletedAt)))
    .limit(1);
  if (!existing) return null;
  await db
    .update(mailSignatures)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(mailSignatures.id, id));
  return existing;
}
