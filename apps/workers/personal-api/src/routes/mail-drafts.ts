/**
 * Personal mail drafts — CRUD (soft delete).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { getPersonalDb, personalSchema } from '../db';
import { generateId } from '../lib/id';
import { cursorPagination, error, list, noContent, success } from '../lib/response';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const { personalMailAccounts, personalMailDrafts } = personalSchema;

const listQuery = z.object({
  accountId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const baseBody = {
  subject: z.string().max(998).optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  replyTo: z.array(z.string()).optional(),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  importance: z.enum(['low', 'normal', 'high']).optional(),
  labels: z.array(z.string()).optional(),
  attachmentIds: z.array(z.string()).optional(),
  inReplyTo: z.string().max(500).optional(),
  originalMessageId: z.string().optional(),
  isReply: z.boolean().optional(),
  isForward: z.boolean().optional(),
} as const;

const createBody = z.object({ accountId: z.string().min(1), ...baseBody });
const updateBody = z.object(baseBody).partial();

type DraftUpdate = z.infer<typeof updateBody>;

/** Draft fields copied to the patch verbatim when supplied. */
const PLAIN_PATCH_FIELDS = [
  'subject',
  'to',
  'cc',
  'bcc',
  'replyTo',
  'body',
  'htmlBody',
  'importance',
  'labels',
  'inReplyTo',
  'originalMessageId',
  'isReply',
  'isForward',
] as const satisfies ReadonlyArray<keyof DraftUpdate>;

/** Build the column patch for a partial draft update; only supplied fields are touched. */
function buildDraftPatch(data: DraftUpdate, now: Date): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    updatedAt: now,
    lastAutoSavedAt: now,
  };

  for (const field of PLAIN_PATCH_FIELDS) {
    if (data[field] !== undefined) patch[field] = data[field];
  }
  if (data.attachmentIds !== undefined) {
    patch.attachmentIds = data.attachmentIds;
    patch.hasAttachments = data.attachmentIds.length > 0;
    patch.attachmentCount = data.attachmentIds.length;
  }
  return patch;
}

async function assertAccountOwned(
  personalDb: ReturnType<typeof getPersonalDb>,
  personalAccountId: string,
  accountId: string,
) {
  const [account] = await personalDb
    .select({ id: personalMailAccounts.id })
    .from(personalMailAccounts)
    .where(
      and(
        eq(personalMailAccounts.id, accountId),
        eq(personalMailAccounts.personalAccountId, personalAccountId),
        isNull(personalMailAccounts.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(account);
}

app.get('/', zValidator('query', listQuery), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const filters = c.req.valid('query');
  const limit = Math.min(filters.limit ?? 50, 100);

  try {
    const personalDb = getPersonalDb(c.env);

    if (filters.accountId) {
      const ok = await assertAccountOwned(personalDb, personalAccountId, filters.accountId);
      if (!ok) return error.notFound(c, 'Mail account', filters.accountId);
    }

    const conditions: SQL[] = [
      eq(personalMailDrafts.personalAccountId, personalAccountId),
      isNull(personalMailDrafts.deletedAt)!,
    ];
    if (filters.accountId) {
      conditions.push(eq(personalMailDrafts.accountId, filters.accountId));
    }

    if (filters.cursor) {
      const [cur] = await personalDb
        .select({ updatedAt: personalMailDrafts.updatedAt, id: personalMailDrafts.id })
        .from(personalMailDrafts)
        .where(eq(personalMailDrafts.id, filters.cursor))
        .limit(1);
      if (cur?.updatedAt) {
        conditions.push(
          sql`(${personalMailDrafts.updatedAt} < ${cur.updatedAt} OR (${personalMailDrafts.updatedAt} = ${cur.updatedAt} AND ${personalMailDrafts.id} < ${cur.id}))`,
        );
      }
    }

    const where = and(...conditions);
    const filterConditions = filters.cursor ? conditions.slice(0, -1) : conditions;
    const countWhere = and(...filterConditions);

    const [rows, countRes] = await Promise.all([
      personalDb
        .select()
        .from(personalMailDrafts)
        .where(where)
        .orderBy(desc(personalMailDrafts.updatedAt), desc(personalMailDrafts.id))
        .limit(limit + 1),
      personalDb
        .select({ count: sql<number>`count(*)::int` })
        .from(personalMailDrafts)
        .where(countWhere),
    ]);

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const cursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);

    return list(c, data, cursorPagination(totalCount, hasMore, cursor));
  } catch (err) {
    console.error('[personal-api/mail-drafts] list failed:', err);
    return error.internal(c, 'Failed to list drafts');
  }
});

app.post('/', zValidator('json', createBody), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const data = c.req.valid('json');

  try {
    const personalDb = getPersonalDb(c.env);
    const ok = await assertAccountOwned(personalDb, personalAccountId, data.accountId);
    if (!ok) return error.notFound(c, 'Mail account', data.accountId);

    const id = generateId('draft');
    const now = new Date();
    const [row] = await personalDb
      .insert(personalMailDrafts)
      .values({
        id,
        personalAccountId,
        accountId: data.accountId,
        subject: data.subject ?? null,
        to: data.to ?? null,
        cc: data.cc ?? null,
        bcc: data.bcc ?? null,
        replyTo: data.replyTo ?? null,
        body: data.body ?? null,
        htmlBody: data.htmlBody ?? null,
        importance: data.importance ?? 'normal',
        labels: data.labels ?? null,
        attachmentIds: data.attachmentIds ?? null,
        hasAttachments: (data.attachmentIds?.length ?? 0) > 0,
        attachmentCount: data.attachmentIds?.length ?? 0,
        inReplyTo: data.inReplyTo ?? null,
        originalMessageId: data.originalMessageId ?? null,
        isReply: data.isReply ?? false,
        isForward: data.isForward ?? false,
        lastAutoSavedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return success(c, row!, 201);
  } catch (err) {
    console.error('[personal-api/mail-drafts] create failed:', err);
    return error.internal(c, 'Failed to create draft');
  }
});

app.patch('/:id', zValidator('json', updateBody), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const personalDb = getPersonalDb(c.env);
    const [existing] = await personalDb
      .select()
      .from(personalMailDrafts)
      .where(
        and(
          eq(personalMailDrafts.id, id),
          eq(personalMailDrafts.personalAccountId, personalAccountId),
          isNull(personalMailDrafts.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) return error.notFound(c, 'Draft', id);

    const patch = buildDraftPatch(data, new Date());

    const [updated] = await personalDb
      .update(personalMailDrafts)
      .set(patch)
      .where(eq(personalMailDrafts.id, id))
      .returning();

    return success(c, updated!);
  } catch (err) {
    console.error('[personal-api/mail-drafts] update failed:', err);
    return error.internal(c, 'Failed to update draft');
  }
});

app.delete('/:id', async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');

  try {
    const personalDb = getPersonalDb(c.env);
    const [existing] = await personalDb
      .select({ id: personalMailDrafts.id })
      .from(personalMailDrafts)
      .where(
        and(
          eq(personalMailDrafts.id, id),
          eq(personalMailDrafts.personalAccountId, personalAccountId),
          isNull(personalMailDrafts.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) return error.notFound(c, 'Draft', id);

    await personalDb
      .update(personalMailDrafts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(personalMailDrafts.id, id));

    return noContent(c);
  } catch (err) {
    console.error('[personal-api/mail-drafts] delete failed:', err);
    return error.internal(c, 'Failed to delete draft');
  }
});

export const mailDraftsRoutes = app;
