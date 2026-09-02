/**
 * Personal mail messages — list, get, patch, and the outbound paths
 * (compose / reply / forward) via Cloudflare Email Sending.
 *
 * Every send funnels through `services/mail-send.ts`, so the daily plan limit,
 * idempotency, HTML sanitizing and thread stitching behave identically no
 * matter which endpoint the client used.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { getPersonalDb, personalSchema } from '../db';
import { cursorPagination, error, list, success } from '../lib/response';
import {
  PersonalMailSendError,
  forwardAndPersist,
  replyAndPersist,
  requireMessage,
  sendAndPersist,
} from '../services/mail-send';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const { personalMailAttachments, personalMailMessages } = personalSchema;

const listQuery = z.object({
  accountId: z.string().optional(),
  label: z.string().optional(),
  threadId: z.string().optional(),
  unreadOnly: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const updateBody = z.object({
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  isTrash: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
});

const emailOrList = z.union([z.string().email(), z.array(z.string().email()).min(1)]);

/** Accept a single address or a list, and always hand the service an array. */
function asList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

const sendBody = z.object({
  accountId: z.string().min(1),
  to: emailOrList,
  cc: emailOrList.optional(),
  bcc: emailOrList.optional(),
  subject: z.string().max(998),
  textBody: z.string().optional(),
  htmlBody: z.string().optional(),
  inReplyTo: z.string().max(500).optional(),
  references: z.array(z.string().max(500)).max(50).optional(),
  threadId: z.string().max(255).optional(),
  idempotencyKey: z.string().min(1).max(64).optional(),
});

const replyBody = z.object({
  textBody: z.string().optional(),
  htmlBody: z.string().optional(),
  replyAll: z.boolean().optional(),
  idempotencyKey: z.string().min(1).max(64).optional(),
});

const forwardBody = z.object({
  to: emailOrList,
  cc: emailOrList.optional(),
  textBody: z.string().optional(),
  htmlBody: z.string().optional(),
  idempotencyKey: z.string().min(1).max(64).optional(),
});

/** Map the one service error type onto the response shapes. */
function mapSendError(c: Parameters<typeof error.badRequest>[0], err: PersonalMailSendError) {
  switch (err.code) {
    case 'ACCOUNT_NOT_FOUND':
      return error.notFound(c, 'Mail account');
    case 'MESSAGE_NOT_FOUND':
      return error.notFound(c, 'Message');
    case 'DAILY_LIMIT_REACHED':
      return error.planLimit(c, err.message, err.details);
    case 'NO_RECIPIENTS':
      return error.badRequest(c, err.message);
    case 'DELIVERY_FAILED':
      return error.unavailable(c, err.message);
    default:
      return error.internal(c, err.message);
  }
}

app.get('/', zValidator('query', listQuery), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const filters = c.req.valid('query');
  const limit = Math.min(filters.limit ?? 50, 100);

  try {
    const personalDb = getPersonalDb(c.env);
    const conditions: SQL[] = [
      eq(personalMailMessages.personalAccountId, personalAccountId),
      isNull(personalMailMessages.deletedAt)!,
    ];

    if (filters.accountId) {
      conditions.push(eq(personalMailMessages.accountId, filters.accountId));
    }
    if (filters.label) {
      conditions.push(
        sql`${personalMailMessages.labels} @> ${JSON.stringify([filters.label])}::jsonb`,
      );
    }
    if (filters.threadId) {
      conditions.push(eq(personalMailMessages.threadId, filters.threadId));
    }
    if (filters.unreadOnly) {
      conditions.push(eq(personalMailMessages.isRead, false));
    }

    // A thread view reads oldest-first (conversation order); every other view
    // is newest-first, and the cursor comparison has to match that direction.
    const ascending = Boolean(filters.threadId);

    if (filters.cursor) {
      const [cur] = await personalDb
        .select({
          sentDate: personalMailMessages.sentDate,
          id: personalMailMessages.id,
        })
        .from(personalMailMessages)
        .where(eq(personalMailMessages.id, filters.cursor))
        .limit(1);
      if (cur?.sentDate) {
        conditions.push(
          ascending
            ? sql`(${personalMailMessages.sentDate} > ${cur.sentDate} OR (${personalMailMessages.sentDate} = ${cur.sentDate} AND ${personalMailMessages.id} > ${cur.id}))`
            : sql`(${personalMailMessages.sentDate} < ${cur.sentDate} OR (${personalMailMessages.sentDate} = ${cur.sentDate} AND ${personalMailMessages.id} < ${cur.id}))`,
        );
      }
    }

    const where = and(...conditions);
    const filterConditions = filters.cursor ? conditions.slice(0, -1) : conditions;
    const countWhere = and(...filterConditions);

    const [rows, countRes] = await Promise.all([
      personalDb
        .select()
        .from(personalMailMessages)
        .where(where)
        .orderBy(
          ascending
            ? asc(personalMailMessages.sentDate)
            : desc(personalMailMessages.sentDate),
          ascending ? asc(personalMailMessages.id) : desc(personalMailMessages.id),
        )
        .limit(limit + 1),
      personalDb
        .select({ count: sql<number>`count(*)::int` })
        .from(personalMailMessages)
        .where(countWhere),
    ]);

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const cursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);

    return list(c, data, cursorPagination(totalCount, hasMore, cursor));
  } catch (err) {
    console.error('[personal-api/mail-messages] list failed:', err);
    return error.internal(c, 'Failed to list messages');
  }
});

/**
 * Unread counts for the inbox badge — total plus a per-account breakdown.
 *
 * Registered before `/:id` so the literal path wins the match.
 */
app.get('/unread-count', async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  try {
    const personalDb = getPersonalDb(c.env);
    const rows = await personalDb
      .select({
        accountId: personalMailMessages.accountId,
        count: sql<number>`count(*)::int`,
      })
      .from(personalMailMessages)
      .where(
        and(
          eq(personalMailMessages.personalAccountId, personalAccountId),
          eq(personalMailMessages.isRead, false),
          eq(personalMailMessages.isTrash, false),
          isNull(personalMailMessages.deletedAt),
          sql`${personalMailMessages.labels} @> ${JSON.stringify(['INBOX'])}::jsonb`,
        ),
      )
      .groupBy(personalMailMessages.accountId);

    const byAccount: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const count = Number(row.count ?? 0);
      byAccount[row.accountId] = count;
      total += count;
    }

    return success(c, { total, byAccount });
  } catch (err) {
    console.error('[personal-api/mail-messages] unread-count failed:', err);
    return error.internal(c, 'Failed to count unread messages');
  }
});

app.post('/send', zValidator('json', sendBody), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const data = c.req.valid('json');

  try {
    const personalDb = getPersonalDb(c.env);
    const { message, pendingVerification } = await sendAndPersist(
      c.env,
      personalDb,
      personalAccountId,
      c.get('entitlements'),
      {
        accountId: data.accountId,
        to: asList(data.to)!,
        cc: asList(data.cc),
        bcc: asList(data.bcc),
        subject: data.subject,
        textBody: data.textBody,
        htmlBody: data.htmlBody,
        inReplyTo: data.inReplyTo,
        references: data.references,
        threadId: data.threadId,
        idempotencyKey: data.idempotencyKey,
      },
    );

    return success(c, { ...message, pendingVerification }, 201);
  } catch (err) {
    if (err instanceof PersonalMailSendError) return mapSendError(c, err);
    console.error('[personal-api/mail-messages] send failed:', err);
    return error.internal(c, 'Failed to send message');
  }
});

app.post('/:id/reply', zValidator('json', replyBody), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const personalDb = getPersonalDb(c.env);
    const { message, pendingVerification, repliedTo } = await replyAndPersist(
      c.env,
      personalDb,
      personalAccountId,
      c.get('entitlements'),
      id,
      data,
    );

    return success(c, { ...message, pendingVerification, repliedTo }, 201);
  } catch (err) {
    if (err instanceof PersonalMailSendError) return mapSendError(c, err);
    console.error('[personal-api/mail-messages] reply failed:', err);
    return error.internal(c, 'Failed to send reply');
  }
});

app.post('/:id/forward', zValidator('json', forwardBody), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const personalDb = getPersonalDb(c.env);
    const { message, pendingVerification, forwardedFrom } = await forwardAndPersist(
      c.env,
      personalDb,
      personalAccountId,
      c.get('entitlements'),
      id,
      {
        to: asList(data.to)!,
        cc: asList(data.cc),
        textBody: data.textBody,
        htmlBody: data.htmlBody,
        idempotencyKey: data.idempotencyKey,
      },
    );

    return success(c, { ...message, pendingVerification, forwardedFrom }, 201);
  } catch (err) {
    if (err instanceof PersonalMailSendError) return mapSendError(c, err);
    console.error('[personal-api/mail-messages] forward failed:', err);
    return error.internal(c, 'Failed to forward message');
  }
});

/** Attachments stored by the inbound worker for one message. */
app.get('/:id/attachments', async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');

  try {
    const personalDb = getPersonalDb(c.env);
    // Ownership is checked on the message, not the attachment rows, so a
    // guessed message id can't leak another account's files.
    await requireMessage(personalDb, personalAccountId, id);

    const rows = await personalDb
      .select()
      .from(personalMailAttachments)
      .where(
        and(
          eq(personalMailAttachments.messageId, id),
          eq(personalMailAttachments.personalAccountId, personalAccountId),
          isNull(personalMailAttachments.deletedAt),
        ),
      )
      .orderBy(asc(personalMailAttachments.createdAt));

    return success(c, rows);
  } catch (err) {
    if (err instanceof PersonalMailSendError) return mapSendError(c, err);
    console.error('[personal-api/mail-messages] attachments failed:', err);
    return error.internal(c, 'Failed to list attachments');
  }
});

app.get('/:id', async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');

  try {
    const personalDb = getPersonalDb(c.env);
    const [row] = await personalDb
      .select()
      .from(personalMailMessages)
      .where(
        and(
          eq(personalMailMessages.id, id),
          eq(personalMailMessages.personalAccountId, personalAccountId),
          isNull(personalMailMessages.deletedAt),
        ),
      )
      .limit(1);

    if (!row) return error.notFound(c, 'Message', id);
    return success(c, row);
  } catch (err) {
    console.error('[personal-api/mail-messages] get failed:', err);
    return error.internal(c, 'Failed to fetch message');
  }
});

app.patch('/:id', zValidator('json', updateBody), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const id = c.req.param('id');
  const body = c.req.valid('json');

  if (
    body.isRead === undefined &&
    body.isStarred === undefined &&
    body.isTrash === undefined &&
    body.labels === undefined
  ) {
    return error.badRequest(c, 'No fields to update');
  }

  try {
    const personalDb = getPersonalDb(c.env);
    const [existing] = await personalDb
      .select({ id: personalMailMessages.id })
      .from(personalMailMessages)
      .where(
        and(
          eq(personalMailMessages.id, id),
          eq(personalMailMessages.personalAccountId, personalAccountId),
          isNull(personalMailMessages.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) return error.notFound(c, 'Message', id);

    const patch: {
      updatedAt: Date;
      isRead?: boolean;
      isStarred?: boolean;
      isTrash?: boolean;
      labels?: string[];
    } = { updatedAt: new Date() };
    if (body.isRead !== undefined) patch.isRead = body.isRead;
    if (body.isStarred !== undefined) patch.isStarred = body.isStarred;
    if (body.isTrash !== undefined) patch.isTrash = body.isTrash;
    if (body.labels !== undefined) patch.labels = body.labels;

    const [updated] = await personalDb
      .update(personalMailMessages)
      .set(patch)
      .where(eq(personalMailMessages.id, id))
      .returning();

    return success(c, updated!);
  } catch (err) {
    console.error('[personal-api/mail-messages] patch failed:', err);
    return error.internal(c, 'Failed to update message');
  }
});

export const mailMessagesRoutes = app;
