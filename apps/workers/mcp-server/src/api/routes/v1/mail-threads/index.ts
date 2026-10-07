/**
 * Mail threads — conversations, the way the WeldMail inbox shows them.
 *
 * A thread has no table of its own. Its key is `COALESCE(threadId, id)` within
 * one account: the shared thread id, or the message id for a message nobody
 * replied to. The list returns that key as `threadId`; pass it, with the
 * thread's `accountId`, to read or change the whole conversation.
 *
 * The list pages by offset under an opaque cursor (the underlying query groups
 * messages into threads, which a keyset cursor cannot follow cheaply). Like the
 * inbox, a list read also returns snoozed mail whose time has come to the inbox.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { canOpenAccount } from '@weldsuite/mail-domain/access';
import { getThreadByKey, listThreadsByLabel } from '@weldsuite/mail-domain/threads';
import { markThreadRead } from '@weldsuite/mail-domain/thread-ops';
import { applyLabelToThread, isLocationLabel, normalizeLabel } from '@weldsuite/mail-domain/labels';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, list, success, cursorPagination } from '../../../lib/response';
import { decodeOffsetCursor, encodeOffsetCursor, mailPrincipal, publicMessage } from '../../../lib/mail';

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  accountId: z.string().optional(),
  /** Folder or label: `inbox` (default), `sent`, `starred`, `archive`, `trash`, `spam`, `all`, or a label name. */
  label: z.string().max(100).optional(),
  search: z.string().max(500).optional(),
  from: z.string().max(200).optional(),
  to: z.string().max(200).optional(),
  subject: z.string().max(200).optional(),
  hasAttachments: z.enum(['true', 'false']).optional(),
});

const accountQuery = z.object({ accountId: z.string().min(1) });

const readBody = z.object({ accountId: z.string().min(1), isRead: z.boolean().default(true) });

const labelName = z.string().trim().min(1).max(100);
const labelsBody = z
  .object({
    accountId: z.string().min(1),
    add: z.array(labelName).max(50).optional(),
    remove: z.array(labelName).max(50).optional(),
  })
  .refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, 'Give labels to add or remove');

const app = new Hono<HonoEnv>();

app.get('/', requireScope('mail_messages:read'), zValidator('query', listQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const principal = mailPrincipal(c);
  const offset = decodeOffsetCursor(q.cursor);
  if (offset === null) return error.badRequest(c, 'Invalid cursor');
  if (q.accountId && !(await canOpenAccount(db, q.accountId, principal))) {
    return error.notFound(c, 'MailAccount', q.accountId);
  }

  const limit = q.limit ?? 25;
  const { threads, totalCount } = await listThreadsByLabel(db, principal, {
    labelSlug: q.label ?? 'inbox',
    accountId: q.accountId,
    pageSize: limit,
    offset,
    search: q.search,
    from: q.from,
    to: q.to,
    subject: q.subject,
    hasAttachment: q.hasAttachments === 'true' ? true : undefined,
  });

  const next = offset + threads.length;
  const hasMore = threads.length > 0 && next < totalCount;
  // The summary's `messages` array holds every message in full; a list only
  // needs the summary.
  const data = threads.map(({ messages: _messages, ...summary }) => summary);
  return list(c, data, cursorPagination(totalCount, hasMore, hasMore ? encodeOffsetCursor(next) : null));
});

app.get('/:threadKey', requireScope('mail_messages:read'), zValidator('query', accountQuery), async (c) => {
  const db = c.get('tenantDb');
  const threadKey = c.req.param('threadKey');
  const { accountId } = c.req.valid('query');
  if (!(await canOpenAccount(db, accountId, mailPrincipal(c)))) return error.notFound(c, 'MailThread', threadKey);
  const thread = await getThreadByKey(db, accountId, threadKey);
  if (!thread) return error.notFound(c, 'MailThread', threadKey);
  return success(c, { ...thread, messages: thread.messages.map(publicMessage) });
});

app.post('/:threadKey/read', requireScope('mail_messages:write'), zValidator('json', readBody), async (c) => {
  const db = c.get('tenantDb');
  const threadKey = c.req.param('threadKey');
  const { accountId, isRead } = c.req.valid('json');
  if (!(await canOpenAccount(db, accountId, mailPrincipal(c)))) return error.notFound(c, 'MailThread', threadKey);
  const result = await markThreadRead(db, accountId, threadKey, isRead);
  if (result.updatedCount > 0) {
    publishEntityEvent({
      c,
      entityType: 'email',
      entityId: threadKey,
      action: 'updated',
      data: { id: threadKey, accountId, subject: null, from: null, to: null, conversationId: threadKey },
    });
  }
  return success(c, { threadId: threadKey, accountId, isRead, updatedCount: result.updatedCount });
});

app.post('/:threadKey/labels', requireScope('mail_messages:write'), zValidator('json', labelsBody), async (c) => {
  const db = c.get('tenantDb');
  const threadKey = c.req.param('threadKey');
  const body = c.req.valid('json');
  if (!(await canOpenAccount(db, body.accountId, mailPrincipal(c)))) {
    return error.notFound(c, 'MailThread', threadKey);
  }

  // Unlike a single message, a thread may be moved through its labels: adding
  // TRASH, ARCHIVE, SPAM or INBOX moves every message in it.
  const changes = [
    ...(body.add ?? []).map((name) => ({ name: normalizeLabel(name), action: 'add' as const })),
    ...(body.remove ?? []).map((name) => ({ name: normalizeLabel(name), action: 'remove' as const })),
  ];
  const removedLocation = changes.find((ch) => ch.action === 'remove' && isLocationLabel(ch.name));
  if (removedLocation) {
    return error.badRequest(c, `${removedLocation.name} is a location: add the location to move the thread there instead.`);
  }

  let affected = 0;
  for (const change of changes) {
    affected = Math.max(affected, (await applyLabelToThread(db, body.accountId, threadKey, change.name, change.action)).affected);
  }
  if (affected === 0) return error.notFound(c, 'MailThread', threadKey);

  publishEntityEvent({
    c,
    entityType: 'email',
    entityId: threadKey,
    action: 'updated',
    data: { id: threadKey, accountId: body.accountId, subject: null, from: null, to: null, conversationId: threadKey },
  });
  return success(c, { threadId: threadKey, accountId: body.accountId, affected });
});

export default app;
