/**
 * Mail draft service.
 *
 * Drafts are unsent compositions held in `mail_drafts` until the user
 * promotes them via the send endpoint on `mail-accounts`. We do not
 * shuttle drafts through the Cloudflare `send_email` binding from here —
 * that's the explicit job of `services/mail/send.ts`.
 */

import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../db';
import type { Database } from '../../db';
import { generateId } from '../../lib/id';

const { mailDrafts } = schema;

export interface ListDraftsFilters {
  accountId?: string;
  limit?: number;
  cursor?: string;
}

export async function listDrafts(db: Database, filters: ListDraftsFilters) {
  const limit = Math.min(filters.limit ?? 50, 100);
  const conditions: SQL[] = [isNull(mailDrafts.deletedAt)!];
  if (filters.accountId) conditions.push(eq(mailDrafts.accountId, filters.accountId));

  if (filters.cursor) {
    const [cur] = await db
      .select({ updatedAt: mailDrafts.updatedAt, id: mailDrafts.id })
      .from(mailDrafts)
      .where(eq(mailDrafts.id, filters.cursor))
      .limit(1);
    if (cur?.updatedAt) {
      conditions.push(
        sql`(${mailDrafts.updatedAt} < ${cur.updatedAt} OR (${mailDrafts.updatedAt} = ${cur.updatedAt} AND ${mailDrafts.id} < ${cur.id}))`,
      );
    }
  }

  const where = and(...conditions);
  const filterConditions = filters.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = and(...filterConditions);

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(mailDrafts)
      .where(where)
      .orderBy(desc(mailDrafts.updatedAt), desc(mailDrafts.id))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(mailDrafts).where(countWhere),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
  const totalCount = Number(countRes[0]?.count ?? 0);
  return { data, hasMore, cursor, totalCount };
}

export async function getDraft(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(mailDrafts)
    .where(and(eq(mailDrafts.id, id), isNull(mailDrafts.deletedAt)))
    .limit(1);
  return row ?? null;
}

export interface DraftInput {
  accountId: string;
  subject?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  body?: string;
  htmlBody?: string;
  importance?: 'low' | 'normal' | 'high';
  labels?: string[];
  attachmentIds?: string[];
  inReplyTo?: string;
  originalMessageId?: string;
  isReply?: boolean;
  isForward?: boolean;
}

export async function createDraft(db: Database, data: DraftInput) {
  const id = generateId('draft');
  const now = new Date();
  await db.insert(mailDrafts).values({
    id,
    ...data,
    hasAttachments: (data.attachmentIds?.length ?? 0) > 0,
    attachmentCount: data.attachmentIds?.length ?? 0,
    lastAutoSavedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(mailDrafts).where(eq(mailDrafts.id, id));
  return row!;
}

export async function updateDraft(db: Database, id: string, data: Partial<DraftInput>) {
  const [existing] = await db
    .select()
    .from(mailDrafts)
    .where(and(eq(mailDrafts.id, id), isNull(mailDrafts.deletedAt)))
    .limit(1);
  if (!existing) return null;

  const patch: Record<string, unknown> = { updatedAt: new Date(), lastAutoSavedAt: new Date() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v;
  if (data.attachmentIds !== undefined) {
    patch.hasAttachments = data.attachmentIds.length > 0;
    patch.attachmentCount = data.attachmentIds.length;
  }

  await db
    .update(mailDrafts)
    .set(patch as typeof mailDrafts.$inferInsert)
    .where(eq(mailDrafts.id, id));
  const [after] = await db.select().from(mailDrafts).where(eq(mailDrafts.id, id));
  return { before: existing, after: after! };
}

export async function softDeleteDraft(db: Database, id: string) {
  const [existing] = await db
    .select({ id: mailDrafts.id, accountId: mailDrafts.accountId })
    .from(mailDrafts)
    .where(and(eq(mailDrafts.id, id), isNull(mailDrafts.deletedAt)))
    .limit(1);
  if (!existing) return null;
  await db
    .update(mailDrafts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(mailDrafts.id, id));
  return existing;
}
