/**
 * Mail messages — read-only.
 *
 * Reading mail, not sending it: list with filters, and fetch one message with
 * its body. Sending and replying stay on the platform's own compose path
 * (`app-api` `mail-accounts/:id/send`), which handles provider routing,
 * threading headers and delivery tracking — none of which belongs behind a
 * tool call. Composing over MCP goes to `mail-drafts` instead, where a human
 * still presses send.
 *
 * Two things differ from the other ported routes:
 *
 * - **Ordering is by `sentDate`, not `createdAt`.** `createdAt` is when the
 *   sync wrote the row, which on a backfilled mailbox bears no relation to
 *   when the mail arrived — "my latest email" would return whatever IMAP
 *   happened to hand over last. So this file carries its own cursor walk
 *   instead of using `listWithCursor`.
 * - **Rows are projected, not selected whole.** A `mail_messages` row carries
 *   `rawMessage`, `htmlBody` and `textBody`; 50 of them would be megabytes of
 *   tool result. Lists get a header-only shape, and bodies appear only on the
 *   single-message read.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../../db';
import type { MailEmailAddress } from '@weldsuite/db/schema/mail-messages';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, list, success, cursorPagination } from '../../../lib/response';
import { clampLimit } from '../../../lib/pagination';
import {
  accessibleAccountIds,
  accountScopeCondition,
  checkAccountAccess,
} from '../../../lib/mail-access';

const table = schema.mailMessages;

/**
 * System labels are stored upper-case (`INBOX`, `SENT`) while user labels keep
 * their own casing. Callers say "inbox"; normalise so both land.
 */
const SYSTEM_LABEL_SLUGS = new Set([
  'inbox',
  'sent',
  'draft',
  'drafts',
  'trash',
  'spam',
  'starred',
  'important',
  'archive',
  'snoozed',
  'scheduled',
  'promotions',
]);

function normaliseLabel(label: string): string {
  return SYSTEM_LABEL_SLUGS.has(label.toLowerCase()) ? label.toUpperCase() : label;
}

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  accountId: z.string().optional(),
  search: z.string().optional(),
  label: z.string().optional(),
  threadId: z.string().optional(),
  from: z.string().optional(),
  isRead: z.coerce.boolean().optional(),
  isStarred: z.coerce.boolean().optional(),
  hasAttachments: z.coerce.boolean().optional(),
  includeTrash: z.coerce.boolean().optional(),
  includeSpam: z.coerce.boolean().optional(),
});

const getQuery = z.object({
  includeHtml: z.coerce.boolean().optional(),
});

/** `{ email, name }` -> `Jan Jansen <jan@acme.nl>`, so a row reads as a sentence. */
function formatAddress(address: MailEmailAddress | null | undefined): string | undefined {
  if (!address?.email) return undefined;
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

function formatAddresses(addresses: MailEmailAddress[] | null | undefined): string | undefined {
  const formatted = (addresses ?? [])
    .map(formatAddress)
    .filter((entry): entry is string => entry !== undefined);
  return formatted.length > 0 ? formatted.join(', ') : undefined;
}

type MessageRow = typeof table.$inferSelect;

/**
 * Columns the list needs. Selected explicitly so the bodies never leave
 * Postgres: `rawMessage` alone can be hundreds of kilobytes, and a `select()`
 * would fetch it (plus both body parts) for every row on the page only for
 * `summariseMessage` to drop it.
 */
const listColumns = {
  id: table.id,
  accountId: table.accountId,
  threadId: table.threadId,
  subject: table.subject,
  from: table.from,
  sentDate: table.sentDate,
  isRead: table.isRead,
  isStarred: table.isStarred,
  isImportant: table.isImportant,
  hasAttachments: table.hasAttachments,
  attachmentCount: table.attachmentCount,
  labels: table.labels,
} as const;

type MessageListRow = {
  [K in keyof typeof listColumns]: MessageRow[K & keyof MessageRow];
};

/**
 * List shape: enough to pick a message out of a page, nothing more. Field
 * order matters — `lib/present.ts` leads each row with the first few content
 * fields, so sender and date come before the flags.
 */
function summariseMessage(row: MessageListRow) {
  return {
    id: row.id,
    accountId: row.accountId,
    threadId: row.threadId,
    subject: row.subject ?? '(no subject)',
    from: formatAddress(row.from),
    sentDate: row.sentDate,
    read: row.isRead,
    // Flags are reported only when set: a `false` on every row is noise, and
    // `present.ts` drops `undefined` for us.
    starred: row.isStarred ? true : undefined,
    important: row.isImportant ? true : undefined,
    attachments: row.hasAttachments ? (row.attachmentCount || 1) : undefined,
    labels: row.labels?.length ? row.labels.join(', ') : undefined,
  };
}

/** Single-message shape: the summary plus recipients, body and provenance. */
function detailMessage(row: MessageRow, includeHtml: boolean) {
  // Prefer the plain-text part. HTML is opt-in because it is typically several
  // times larger and mostly markup the model has to wade through.
  const text = row.textBody?.trim() || undefined;
  const html = row.htmlBody?.trim() || undefined;

  return {
    id: row.id,
    accountId: row.accountId,
    threadId: row.threadId,
    messageId: row.messageId,
    subject: row.subject ?? '(no subject)',
    from: formatAddress(row.from),
    to: formatAddresses(row.to),
    cc: formatAddresses(row.cc),
    replyTo: formatAddress(row.replyTo),
    sentDate: row.sentDate,
    receivedDate: row.receivedDate,
    read: row.isRead,
    starred: row.isStarred ? true : undefined,
    important: row.isImportant ? true : undefined,
    spam: row.isSpam ? true : undefined,
    trash: row.isTrash ? true : undefined,
    priority: row.priority,
    labels: row.labels?.length ? row.labels.join(', ') : undefined,
    attachments: row.hasAttachments ? (row.attachmentCount || 1) : undefined,
    inReplyTo: row.inReplyTo,
    body: text,
    // Fall back to HTML when there is no text part, so a message is never
    // returned empty just because the sender skipped multipart/alternative.
    htmlBody: includeHtml || !text ? html : undefined,
    // Headers-only rows are a real sync state; saying so beats a record that
    // looks like a bug.
    bodyNote: !text && !html ? 'This message has no stored body.' : undefined,
  };
}

const app = new Hono<HonoEnv>();

app.get('/', requireScope('messages:read'), zValidator('query', listQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const userId = c.get('userId');

  if (q.accountId && !(await checkAccountAccess(db, q.accountId, userId))) {
    return error.notFound(c, 'MailAccount', q.accountId);
  }

  const conditions: SQL[] = [isNull(table.deletedAt)];

  const scope = accountScopeCondition(table.accountId, await accessibleAccountIds(db, userId));
  if (scope) conditions.push(scope);
  if (q.accountId) conditions.push(eq(table.accountId, q.accountId));
  if (q.threadId) conditions.push(eq(table.threadId, q.threadId));
  if (typeof q.isRead === 'boolean') conditions.push(eq(table.isRead, q.isRead));
  if (typeof q.isStarred === 'boolean') conditions.push(eq(table.isStarred, q.isStarred));
  if (typeof q.hasAttachments === 'boolean') {
    conditions.push(eq(table.hasAttachments, q.hasAttachments));
  }
  if (q.label) {
    conditions.push(sql`${table.labels} @> ${JSON.stringify([normaliseLabel(q.label)])}::jsonb`);
  }
  if (q.from) {
    const term = `%${q.from}%`;
    conditions.push(
      or(sql`${table.from}->>'email' ILIKE ${term}`, sql`${table.from}->>'name' ILIKE ${term}`)!,
    );
  }
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(
      or(ilike(table.subject, term), ilike(table.preview, term), ilike(table.textBody, term))!,
    );
  }
  // Junk stays out of a plain "show me my mail" unless it is what was asked
  // for. `includeTrash` / `includeSpam` opt back in.
  if (!q.includeTrash) conditions.push(or(eq(table.isTrash, false), isNull(table.isTrash))!);
  if (!q.includeSpam) conditions.push(or(eq(table.isSpam, false), isNull(table.isSpam))!);

  const limit = clampLimit(q.limit);

  // Cursor walk on (sentDate DESC, id DESC) — same contract as
  // `listWithCursor`, different sort key. The cursor is the last row's id; its
  // sentDate is looked up to place the next page.
  const pageConditions = [...conditions];
  if (q.cursor) {
    const [cursorRow] = await db
      .select({ sentDate: table.sentDate, id: table.id })
      .from(table)
      .where(eq(table.id, q.cursor))
      .limit(1);
    if (cursorRow) {
      pageConditions.push(
        sql`(${table.sentDate} < ${cursorRow.sentDate} OR (${table.sentDate} = ${cursorRow.sentDate} AND ${table.id} < ${cursorRow.id}))`,
      );
    }
  }

  const [rows, countResult] = await Promise.all([
    db
      .select(listColumns)
      .from(table)
      .where(and(...pageConditions))
      .orderBy(desc(table.sentDate), desc(table.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)` })
      .from(table)
      .where(and(...conditions)),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  return list(
    c,
    page.map(summariseMessage),
    cursorPagination(Number(countResult[0]?.count ?? 0), hasMore, nextCursor),
  );
});

app.get('/:id', requireScope('messages:read'), zValidator('query', getQuery), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Email', id);
  if (!(await checkAccountAccess(db, row.accountId, c.get('userId')))) {
    return error.forbidden(c, 'Access to this mail account is not allowed');
  }

  return success(c, detailMessage(row, c.req.valid('query').includeHtml === true));
});

export default app;
