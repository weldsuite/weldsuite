/**
 * Personal mail messages — list, get, patch, send via Cloudflare Email Sending.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { getPersonalDb, personalSchema } from '../db';
import { generateId } from '../lib/id';
import { cursorPagination, error, list, success } from '../lib/response';
import { sendEmail } from '../lib/cloudflare-email';
import type { Env, Variables } from '../types';
import type { PersonalMailEmailAddress } from '@weldsuite/db/schema/personal';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const { personalMailAccounts, personalMailMessages } = personalSchema;

function asAddresses(
  value: string | string[] | undefined,
): PersonalMailEmailAddress[] | undefined {
  if (value === undefined) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((email) => ({ email }));
}

function previewFrom(textBody?: string, htmlBody?: string): string | null {
  const raw = textBody?.trim() || htmlBody?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
  if (!raw) return null;
  return raw.slice(0, 500);
}

const listQuery = z.object({
  accountId: z.string().optional(),
  label: z.string().optional(),
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

const sendBody = z.object({
  accountId: z.string().min(1),
  to: emailOrList,
  cc: emailOrList.optional(),
  bcc: emailOrList.optional(),
  subject: z.string().max(998),
  textBody: z.string().optional(),
  htmlBody: z.string().optional(),
  inReplyTo: z.string().max(500).optional(),
  threadId: z.string().max(255).optional(),
  idempotencyKey: z.string().min(1).max(64).optional(),
});

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
          sql`(${personalMailMessages.sentDate} < ${cur.sentDate} OR (${personalMailMessages.sentDate} = ${cur.sentDate} AND ${personalMailMessages.id} < ${cur.id}))`,
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
        .orderBy(desc(personalMailMessages.sentDate), desc(personalMailMessages.id))
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

app.post('/send', zValidator('json', sendBody), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const entitlements = c.get('entitlements');
  const data = c.req.valid('json');

  try {
    const personalDb = getPersonalDb(c.env);

    const [account] = await personalDb
      .select()
      .from(personalMailAccounts)
      .where(
        and(
          eq(personalMailAccounts.id, data.accountId),
          eq(personalMailAccounts.personalAccountId, personalAccountId),
          isNull(personalMailAccounts.deletedAt),
        ),
      )
      .limit(1);

    if (!account) return error.notFound(c, 'Mail account', data.accountId);

    // Daily send limit from Clerk Billing entitlements
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [sentTodayRow] = await personalDb
      .select({ count: sql<number>`count(*)::int` })
      .from(personalMailMessages)
      .where(
        and(
          eq(personalMailMessages.accountId, data.accountId),
          eq(personalMailMessages.source, 'composed'),
          sql`${personalMailMessages.sentDate} >= ${dayStart}`,
          isNull(personalMailMessages.deletedAt),
        ),
      );
    const sentToday = Number(sentTodayRow?.count ?? 0);
    if (sentToday >= entitlements.dailySendLimit) {
      return error.planLimit(
        c,
        `Daily send limit of ${entitlements.dailySendLimit} reached. Upgrade to Pro for a higher limit.`,
        { plan: entitlements.plan, dailySendLimit: entitlements.dailySendLimit },
      );
    }

    if (data.idempotencyKey) {
      const [prior] = await personalDb
        .select()
        .from(personalMailMessages)
        .where(
          and(
            eq(personalMailMessages.accountId, data.accountId),
            eq(personalMailMessages.idempotencyKey, data.idempotencyKey),
          ),
        )
        .limit(1);
      if (prior) return success(c, prior);
    }

    const to = asAddresses(data.to)!;
    const cc = asAddresses(data.cc);
    const bcc = asAddresses(data.bcc);

    const fromHeader = account.displayName
      ? `"${account.displayName}" <${account.email}>`
      : account.email;

    let providerMessageId: string;
    let pendingVerification = false;
    try {
      const sent = await sendEmail(c.env, {
        from: fromHeader,
        to: to.map((a) => a.email),
        cc: cc?.map((a) => a.email),
        bcc: bcc?.map((a) => a.email),
        subject: data.subject,
        text: data.textBody,
        html: data.htmlBody,
        inReplyTo: data.inReplyTo,
      });
      providerMessageId = sent.messageId;
      pendingVerification = !!sent.pendingVerification;
    } catch (err) {
      console.error('[personal-api/mail-messages] CF send failed:', err);
      return error.unavailable(
        c,
        err instanceof Error ? err.message : 'Email delivery failed',
      );
    }

    const id = generateId('msg');
    const now = new Date();
    const messageId = providerMessageId.startsWith('<')
      ? providerMessageId
      : `<${providerMessageId}@weldmail.com>`;

    const [created] = await personalDb
      .insert(personalMailMessages)
      .values({
        id,
        personalAccountId,
        accountId: data.accountId,
        messageId,
        threadId: data.threadId ?? id,
        from: {
          email: account.email,
          name: account.displayName ?? account.name,
        },
        to,
        cc: cc ?? null,
        bcc: bcc ?? null,
        subject: data.subject,
        preview: previewFrom(data.textBody, data.htmlBody),
        textBody: data.textBody ?? null,
        htmlBody: data.htmlBody ?? null,
        sentDate: now,
        receivedDate: now,
        isRead: true,
        isStarred: false,
        isDraft: false,
        isSpam: false,
        isTrash: false,
        hasAttachments: false,
        inReplyTo: data.inReplyTo ?? null,
        isReply: Boolean(data.inReplyTo),
        labels: ['SENT'],
        sendStatus: pendingVerification ? 'pending_verification' : 'sent',
        sendProvider: 'cloudflare',
        providerMessageId,
        source: 'composed',
        idempotencyKey: data.idempotencyKey ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await personalDb
      .update(personalMailAccounts)
      .set({
        sentToday: (account.sentToday ?? 0) + 1,
        updatedAt: now,
      })
      .where(eq(personalMailAccounts.id, account.id));

    return success(c, { ...created!, pendingVerification }, 201);
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === '23505' &&
      data.idempotencyKey
    ) {
      try {
        const personalDb = getPersonalDb(c.env);
        const [prior] = await personalDb
          .select()
          .from(personalMailMessages)
          .where(
            and(
              eq(personalMailMessages.accountId, data.accountId),
              eq(personalMailMessages.idempotencyKey, data.idempotencyKey),
            ),
          )
          .limit(1);
        if (prior) return success(c, prior);
      } catch {
        // fall through
      }
    }
    console.error('[personal-api/mail-messages] send failed:', err);
    return error.internal(c, 'Failed to send message');
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
