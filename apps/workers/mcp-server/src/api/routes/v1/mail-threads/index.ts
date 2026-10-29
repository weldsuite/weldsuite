/**
 * Mail threads — conversations, the way the WeldMail inbox shows them.
 *
 * A thread has no table of its own. Its key is `COALESCE(threadId, id)` within
 * one account: the shared thread id, or the message id for a message nobody
 * replied to. The list returns that key as `threadId`; pass it, with the
 * thread's `accountId`, to read or change the whole conversation.
 *
 * The list accepts an opaque `cursor`. New pages are minted as a keyset cursor
 * (design docs/plans/weldmail-mailbox-store-design.md §5), which works the
 * same in every mailbox-store mode; a legacy offset cursor a client already
 * holds is still decoded (design: "legacy `o:<offset>` is still decoded").
 * Like the inbox, a list read also returns snoozed mail whose time has come to
 * the inbox.
 *
 * Reads and organize ops go through `getWorkspaceMail`'s `store`/`access`
 * (task D5), via `../../../lib/mail-store-context`.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { isLocationLabel, normalizeLabel } from '@weldsuite/mail-domain/labels';
import type { ThreadListQuery } from '@weldsuite/mail-domain/store';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, list, success, cursorPagination } from '../../../lib/response';
import {
  decodeOffsetCursor,
  decodeThreadCursor,
  encodeThreadCursor,
  publicMessage,
} from '../../../lib/mail';
import { workspaceMailFromContext } from '../../../lib/mail-store-context';

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

type DecodedCursor =
  | { ok: true; cursor?: NonNullable<ReturnType<typeof decodeThreadCursor>>; offset?: number }
  | { ok: false };

/**
 * Decodes an incoming `cursor` into either a keyset position (the new format)
 * or a legacy offset. No cursor → first page (offset 0). A string that
 * decodes as neither is invalid input, not "start over" — the existing
 * contract answers 400 for a garbled cursor.
 */
function decodeListCursor(raw: string | undefined): DecodedCursor {
  if (!raw) return { ok: true, offset: 0 };
  const cursor = decodeThreadCursor(raw);
  if (cursor) return { ok: true, cursor };
  const offset = decodeOffsetCursor(raw);
  if (offset !== null) return { ok: true, offset };
  return { ok: false };
}

app.get('/', requireScope('mail_messages:read'), zValidator('query', listQuery), async (c) => {
  const q = c.req.valid('query');
  const decoded = decodeListCursor(q.cursor);
  if (!decoded.ok) return error.badRequest(c, 'Invalid cursor');

  const { store, access } = await workspaceMailFromContext(c);
  let accountIds: string[];
  if (q.accountId) {
    if (!(await access.canOpen(q.accountId))) return error.notFound(c, 'MailAccount', q.accountId);
    accountIds = [q.accountId];
  } else {
    accountIds = await access.accessibleAccountIds();
    if (accountIds.length === 0) return list(c, [], cursorPagination(0, false, null));
  }

  const query: ThreadListQuery = {
    labelSlug: q.label ?? 'inbox',
    search: q.search,
    from: q.from,
    to: q.to,
    subject: q.subject,
    hasAttachment: q.hasAttachments === 'true' ? true : undefined,
    pageSize: q.limit ?? 25,
    cursor: decoded.cursor ?? undefined,
    offset: decoded.cursor ? undefined : decoded.offset,
  };
  const result =
    accountIds.length === 1
      ? await store.mailbox(accountIds[0]!).listThreads(query)
      : await store.listThreads(accountIds, query);

  // The summary's `messages` array holds every message in full; a list only
  // needs the summary.
  const data = result.threads.map(({ messages: _messages, ...summary }) => summary);
  const nextCursor = result.nextCursor ? encodeThreadCursor(result.nextCursor) : null;
  return list(c, data, cursorPagination(result.totalCount, nextCursor !== null, nextCursor));
});

app.get('/:threadKey', requireScope('mail_messages:read'), zValidator('query', accountQuery), async (c) => {
  const threadKey = c.req.param('threadKey');
  const { accountId } = c.req.valid('query');
  const { store, access } = await workspaceMailFromContext(c);
  if (!(await access.canOpen(accountId))) return error.notFound(c, 'MailThread', threadKey);
  const thread = await store.mailbox(accountId).getThread(threadKey);
  if (!thread) return error.notFound(c, 'MailThread', threadKey);
  return success(c, { ...thread, messages: thread.messages.map(publicMessage) });
});

app.post('/:threadKey/read', requireScope('mail_messages:write'), zValidator('json', readBody), async (c) => {
  const threadKey = c.req.param('threadKey');
  const { accountId, isRead } = c.req.valid('json');
  const { store, access } = await workspaceMailFromContext(c);
  if (!(await access.canOpen(accountId))) return error.notFound(c, 'MailThread', threadKey);
  const result = await store.mailbox(accountId).apply({ kind: 'thread.read', threadKey, isRead });
  const updatedCount = (result.updatedIds ?? []).length;
  if (updatedCount > 0) {
    publishEntityEvent({
      c,
      entityType: 'email',
      entityId: threadKey,
      action: 'updated',
      data: { id: threadKey, accountId, subject: null, from: null, to: null, conversationId: threadKey },
    });
  }
  return success(c, { threadId: threadKey, accountId, isRead, updatedCount });
});

app.post('/:threadKey/labels', requireScope('mail_messages:write'), zValidator('json', labelsBody), async (c) => {
  const threadKey = c.req.param('threadKey');
  const body = c.req.valid('json');
  const { store, access } = await workspaceMailFromContext(c);
  if (!(await access.canOpen(body.accountId))) return error.notFound(c, 'MailThread', threadKey);

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

  // `MailboxOp`'s `thread.label` reports `updatedIds` as the thread's changed
  // message ids (same shape `thread.read` uses), so `affected` is a true
  // per-message count — take the largest across changes, since one add/remove
  // in the loop may touch fewer messages than another (e.g. some already
  // carried the label being added).
  let affected = 0;
  for (const change of changes) {
    const result = await store
      .mailbox(body.accountId)
      .apply({ kind: 'thread.label', threadKey, label: change.name, action: change.action });
    affected = Math.max(affected, (result.updatedIds ?? result.applied).length);
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
