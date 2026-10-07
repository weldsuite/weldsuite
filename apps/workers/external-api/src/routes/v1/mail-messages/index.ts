/**
 * Mail messages — read and organize.
 *
 * Lists return headers only (no bodies), newest `sentDate` first: `createdAt`
 * is when sync wrote the row, which on a backfilled mailbox says nothing about
 * when the mail arrived. Bodies come with the single-message read.
 *
 * Organizing (flags, labels, moving, bulk, delete) changes WeldSuite's copy
 * only. Nothing is written back to Gmail, Outlook or IMAP.
 *
 * Every route is scoped to the caller's mailboxes (see `lib/mail.ts`). Lists
 * never widen to "every mailbox": without an `accountId` they cover exactly the
 * accounts the principal can open, and a message elsewhere is a 404.
 *
 * Reply and forward live in `mail-sending`, which only the public API mounts.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, inArray, isNull } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { accessibleAccountIds, canOpenAccount, emailEventData } from '@weldsuite/mail-domain/access';
import {
  addMessageLabels,
  bulkUpdateMessages,
  getMessage,
  getMessageAccountId,
  listMessages,
  removeMessageLabels,
  softDeleteMessage,
  updateMessage,
} from '@weldsuite/mail-domain/messages';
import { isLocationLabel, moveMessagesToLocation, normalizeLabel, SYSTEM_LABELS } from '@weldsuite/mail-domain/labels';
import { listAttachmentsForMessage } from '@weldsuite/mail-domain/attachments';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { mailPrincipal, parseBoolFlag, publicAttachment, publicMessage } from '../../../lib/mail';

const { mailMessages } = schema;

const LOCATIONS = {
  inbox: SYSTEM_LABELS.INBOX,
  archive: SYSTEM_LABELS.ARCHIVE,
  trash: SYSTEM_LABELS.TRASH,
  spam: SYSTEM_LABELS.SPAM,
} as const;

const boolFlag = z.enum(['true', 'false']).optional();

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  accountId: z.string().optional(),
  search: z.string().max(500).optional(),
  /** The sender's name or address contains this text. */
  from: z.string().max(200).optional(),
  label: z.string().max(100).optional(),
  threadId: z.string().optional(),
  isRead: boolFlag,
  isStarred: boolFlag,
  isFlagged: boolFlag,
  hasAttachments: boolFlag,
  /** Trash and spam are left out unless asked for, or unless `label` names them. */
  includeTrash: boolFlag,
  includeSpam: boolFlag,
});

const getQuery = z.object({
  /**
   * `false` returns the plain-text body only (the HTML stays when there is no
   * text part). Default `true`.
   */
  includeHtml: boolFlag,
});

const updateBody = z
  .object({
    isRead: z.boolean().optional(),
    isStarred: z.boolean().optional(),
    isFlagged: z.boolean().optional(),
    isImportant: z.boolean().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to update');

const labelName = z.string().trim().min(1).max(100);
const labelsBody = z
  .object({ add: z.array(labelName).max(50).optional(), remove: z.array(labelName).max(50).optional() })
  .refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, 'Give labels to add or remove');

const moveBody = z.object({ location: z.enum(['inbox', 'archive', 'trash', 'spam']) });

const BULK_ACTIONS = [
  'markRead',
  'markUnread',
  'star',
  'unstar',
  'flag',
  'unflag',
  'archive',
  'trash',
  'spam',
  'restore',
  'delete',
] as const;
const bulkBody = z.object({
  ids: z.array(z.string()).min(1).max(100),
  action: z.enum(BULK_ACTIONS),
});

const app = new Hono<HonoEnv>();

/** The message's account when the caller may open it, otherwise null (→ 404). */
async function reachableAccountId(c: Context<HonoEnv>, id: string): Promise<string | null> {
  const db = c.get('tenantDb');
  const accountId = await getMessageAccountId(db, id);
  if (!accountId || !(await canOpenAccount(db, accountId, mailPrincipal(c)))) return null;
  return accountId;
}

/** A content-free `email` event: label and bulk changes need ids, nothing more. */
function publishIdOnly(c: Context<HonoEnv>, id: string, accountId: string, action: 'updated' | 'deleted') {
  publishEntityEvent({
    c,
    entityType: 'email',
    entityId: id,
    action,
    data: { id, accountId, subject: null, from: null, to: null },
  });
}

app.get('/', requireScope('mail_messages:read'), zValidator('query', listQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const principal = mailPrincipal(c);

  if (q.accountId && !(await canOpenAccount(db, q.accountId, principal))) {
    return error.notFound(c, 'MailAccount', q.accountId);
  }
  const scope = q.accountId ? undefined : await accessibleAccountIds(db, principal);
  if (scope && scope.length === 0) return list(c, [], cursorPagination(0, false, null));

  const label = q.label ? normalizeLabel(q.label) : undefined;
  const result = await listMessages(db, {
    accountId: q.accountId,
    accessibleAccountIds: scope,
    cursor: q.cursor,
    limit: q.limit,
    search: q.search,
    from: q.from,
    label,
    threadId: q.threadId,
    isRead: parseBoolFlag(q.isRead),
    isStarred: parseBoolFlag(q.isStarred),
    isFlagged: parseBoolFlag(q.isFlagged),
    hasAttachments: parseBoolFlag(q.hasAttachments),
    excludeTrash: q.includeTrash !== 'true' && label !== SYSTEM_LABELS.TRASH,
    excludeSpam: q.includeSpam !== 'true' && label !== SYSTEM_LABELS.SPAM,
  });
  return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.post('/bulk', requireScope('mail_messages:write'), zValidator('json', bulkBody), async (c) => {
  const db = c.get('tenantDb');
  const { ids, action } = c.req.valid('json');
  const unique = [...new Set(ids)];

  // Every id must be a live message in a mailbox the caller can open; one that
  // isn't fails the whole request rather than being silently skipped.
  const rows = await db
    .select({ id: mailMessages.id, accountId: mailMessages.accountId })
    .from(mailMessages)
    .where(and(inArray(mailMessages.id, unique), isNull(mailMessages.deletedAt)));
  const reachable = new Set(await accessibleAccountIds(db, mailPrincipal(c)));
  const accountOf = new Map(rows.filter((r) => reachable.has(r.accountId)).map((r) => [r.id, r.accountId]));
  const missing = unique.find((id) => !accountOf.has(id));
  if (missing) return error.notFound(c, 'Message', missing);

  switch (action) {
    case 'archive':
      await moveMessagesToLocation(db, unique, SYSTEM_LABELS.ARCHIVE);
      break;
    case 'spam':
      await moveMessagesToLocation(db, unique, SYSTEM_LABELS.SPAM);
      break;
    default:
      await bulkUpdateMessages(db, unique, action);
  }

  for (const id of unique) publishIdOnly(c, id, accountOf.get(id)!, action === 'delete' ? 'deleted' : 'updated');
  return success(c, { affected: unique.length, action });
});

app.get('/:id', requireScope('mail_messages:read'), zValidator('query', getQuery), async (c) => {
  const id = c.req.param('id');
  if (!(await reachableAccountId(c, id))) return error.notFound(c, 'Message', id);
  const row = await getMessage(c.get('tenantDb'), id);
  if (!row) return error.notFound(c, 'Message', id);
  const { attachments, ...message } = row;
  const textOnly = c.req.valid('query').includeHtml === 'false' && !!message.textBody?.trim();
  return success(c, {
    ...publicMessage(message),
    ...(textOnly ? { htmlBody: null } : {}),
    attachments: attachments.filter((a) => !a.deletedAt).map(publicAttachment),
  });
});

app.get('/:id/attachments', requireScope('mail_attachments:read'), async (c) => {
  const id = c.req.param('id');
  if (!(await reachableAccountId(c, id))) return error.notFound(c, 'Message', id);
  const rows = await listAttachmentsForMessage(c.get('tenantDb'), id);
  return list(c, rows.map(publicAttachment), cursorPagination(rows.length, false, null));
});

app.patch('/:id', requireScope('mail_messages:write'), zValidator('json', updateBody), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  if (!(await reachableAccountId(c, id))) return error.notFound(c, 'Message', id);
  const after = await updateMessage(db, id, c.req.valid('json'));
  if (!after) return error.notFound(c, 'Message', id);
  publishEntityEvent({
    c,
    entityType: 'email',
    entityId: id,
    action: 'updated',
    data: await emailEventData(db, {
      id,
      accountId: after.accountId,
      subject: after.subject ?? null,
      from: (after.from as { email?: string } | null)?.email ?? null,
      to: (after.to as { email?: string }[] | null)?.map((t) => t.email ?? '').filter(Boolean) ?? null,
    }),
  });
  return success(c, publicMessage(after));
});

app.post('/:id/labels', requireScope('mail_messages:write'), zValidator('json', labelsBody), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const accountId = await reachableAccountId(c, id);
  if (!accountId) return error.notFound(c, 'Message', id);

  const body = c.req.valid('json');
  const add = (body.add ?? []).map(normalizeLabel);
  const remove = (body.remove ?? []).map(normalizeLabel);
  const location = [...add, ...remove].find(isLocationLabel);
  if (location) {
    return error.badRequest(c, `${location} is a location, not a label. Use POST /v1/mail-messages/${id}/move.`);
  }

  let labels: string[] | null = null;
  if (add.length) labels = await addMessageLabels(db, id, add);
  if (remove.length) labels = await removeMessageLabels(db, id, remove);
  if (labels === null) return error.notFound(c, 'Message', id);

  publishIdOnly(c, id, accountId, 'updated');
  return success(c, { id, labels });
});

app.post('/:id/move', requireScope('mail_messages:write'), zValidator('json', moveBody), async (c) => {
  const id = c.req.param('id');
  const accountId = await reachableAccountId(c, id);
  if (!accountId) return error.notFound(c, 'Message', id);
  const { location } = c.req.valid('json');
  await moveMessagesToLocation(c.get('tenantDb'), [id], LOCATIONS[location]);
  publishIdOnly(c, id, accountId, 'updated');
  return success(c, { id, location });
});

app.delete('/:id', requireScope('mail_messages:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  if (!(await reachableAccountId(c, id))) return error.notFound(c, 'Message', id);
  const deleted = await softDeleteMessage(db, id);
  if (!deleted) return error.notFound(c, 'Message', id);
  publishEntityEvent({
    c,
    entityType: 'email',
    entityId: id,
    action: 'deleted',
    data: await emailEventData(db, { id, accountId: deleted.accountId, subject: deleted.subject, from: null, to: null }),
  });
  return noContent(c);
});

export default app;
