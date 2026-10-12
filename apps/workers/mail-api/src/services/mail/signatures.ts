/**
 * Mail signature service.
 *
 * Signatures are workspace rows with two kinds of owner:
 * - `personal`: one member's own signature. Its owner is the single entry in
 *   `userIds`, and nobody else can see or change it.
 * - `company` / `department`: shared with everyone in the workspace.
 *
 * `accountIds` limits a signature to some mail accounts; empty (or null) means
 * every account. `isDefault` marks the signature compose inserts on its own,
 * and is unique per owner scope among signatures whose accounts overlap: making
 * one the default unsets the defaults it would compete with, never another
 * member's or one for different accounts.
 */

import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

const { mailSignatures } = schema;

export type SignatureType = 'personal' | 'company' | 'department';
type SignatureRow = typeof mailSignatures.$inferSelect;

/** Shared signatures are visible to the whole workspace; changing them is an admin matter. */
export const isSharedSignatureType = (type: SignatureType): boolean => type !== 'personal';

/** What the caller can see: shared signatures plus their own personal ones. */
function visibleTo(userId: string): SQL {
  return or(
    ne(mailSignatures.type, 'personal'),
    sql`${mailSignatures.userIds} @> ${JSON.stringify([userId])}::jsonb`,
  )!;
}

/** Two account lists overlap when either covers every account or they share one. */
export function accountsOverlap(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  if (!a?.length || !b?.length) return true;
  return a.some((id) => b.includes(id));
}

export interface ListSignaturesFilters {
  type?: SignatureType;
  limit?: number;
  cursor?: string;
}

export async function listSignatures(db: Database, userId: string, filters: ListSignaturesFilters) {
  const limit = Math.min(filters.limit ?? 50, 100);
  const conditions: SQL[] = [isNull(mailSignatures.deletedAt), visibleTo(userId)];
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

/** A signature the caller can see, or null (another member's personal one included). */
export async function getSignature(db: Database, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(mailSignatures)
    .where(and(eq(mailSignatures.id, id), isNull(mailSignatures.deletedAt), visibleTo(userId)))
    .limit(1);
  return row ?? null;
}

export interface SignatureInput {
  name: string;
  content: string;
  isDefault?: boolean;
  type?: SignatureType;
  accountIds?: string[];
  userIds?: string[];
  includeInReplies?: boolean;
  includeInForwards?: boolean;
  position?: 'above' | 'below';
  tags?: string[];
}

/**
 * Unsets the defaults the signature `keepId` now replaces: same owner scope,
 * overlapping accounts.
 */
async function clearCompetingDefaults(
  db: Database,
  userId: string,
  target: { id: string; type: SignatureType; accountIds: string[] | null | undefined },
) {
  const scope = isSharedSignatureType(target.type)
    ? ne(mailSignatures.type, 'personal')
    : and(
        eq(mailSignatures.type, 'personal'),
        sql`${mailSignatures.userIds} @> ${JSON.stringify([userId])}::jsonb`,
      );
  const defaults = await db
    .select({ id: mailSignatures.id, accountIds: mailSignatures.accountIds })
    .from(mailSignatures)
    .where(
      and(
        isNull(mailSignatures.deletedAt),
        eq(mailSignatures.isDefault, true),
        ne(mailSignatures.id, target.id),
        scope,
      ),
    );
  const competing = defaults
    .filter((row) => accountsOverlap(row.accountIds, target.accountIds))
    .map((row) => row.id);
  if (competing.length === 0) return;
  await db
    .update(mailSignatures)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(inArray(mailSignatures.id, competing));
}

export async function createSignature(db: Database, userId: string, data: SignatureInput) {
  const type = data.type ?? 'personal';
  const id = generateId('msig');
  const now = new Date();
  await db.insert(mailSignatures).values({
    id,
    ...data,
    type,
    // A personal signature always belongs to whoever made it.
    userIds: isSharedSignatureType(type) ? (data.userIds ?? null) : [userId],
    isDefault: data.isDefault ?? false,
    createdAt: now,
    updatedAt: now,
  });
  if (data.isDefault) {
    await clearCompetingDefaults(db, userId, { id, type, accountIds: data.accountIds });
  }
  const [row] = await db.select().from(mailSignatures).where(eq(mailSignatures.id, id));
  return row!;
}

export async function updateSignature(
  db: Database,
  userId: string,
  existing: SignatureRow,
  data: Partial<SignatureInput>,
) {
  const type = data.type ?? existing.type;
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v;
  if (isSharedSignatureType(type)) {
    if (!isSharedSignatureType(existing.type) && data.userIds === undefined) patch.userIds = null;
  } else {
    // Made personal (or kept personal): it belongs to the caller, the only one who can see it now.
    patch.userIds = [userId];
  }
  await db
    .update(mailSignatures)
    .set(patch as typeof mailSignatures.$inferInsert)
    .where(eq(mailSignatures.id, existing.id));
  const [after] = await db.select().from(mailSignatures).where(eq(mailSignatures.id, existing.id));
  if (after!.isDefault && (data.isDefault || data.accountIds !== undefined || data.type !== undefined)) {
    await clearCompetingDefaults(db, userId, { id: after!.id, type: after!.type, accountIds: after!.accountIds });
  }
  return { before: existing, after: after! };
}

export async function softDeleteSignature(db: Database, existing: SignatureRow) {
  await db
    .update(mailSignatures)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(mailSignatures.id, existing.id));
  return existing;
}
