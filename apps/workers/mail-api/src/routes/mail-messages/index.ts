/**
 * Mail message routes — /api/mail-messages/*.
 *
 * Reads, patches, deletes, bulk-actions, label adds/removes, and the
 * `POST /:id/reply` send path (which goes through the Cloudflare
 * `send_email` binding via the shared `mail/send.ts` helper).
 *
 * Compose-new lives on `/api/mail-accounts/:id/send` because it's tied to
 * the sending account, not to any existing message.
 *
 * Every read/write of message data (list, stats, get, patch, delete, bulk,
 * labels) goes through `workspaceMailFromContext`'s `store`/`access`
 * (design docs/plans/weldmail-mailbox-store-design.md, task D2), so it works
 * the same in every mailbox-store mode. `/:id/reply` and `/:id/forward` are
 * send paths — out of scope here (task D1 routes sends through the store) —
 * so they keep calling `@weldsuite/mail-domain/messages`/`access` directly.
 *
 * Entity events: `email:created | updated | deleted | reply_sent`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import type { Database } from '@weldsuite/worker-kit/db';
import * as messages from '@weldsuite/mail-domain/messages';
import { toPublicAttachment } from '@weldsuite/mail-domain/attachments';
import { forwardAndPersist, MailSendError, replyAndPersist } from '@weldsuite/mail-domain/send';
import { sendErrorResponse } from '../../lib/send-errors';
import { clearsUnreadBanner, queueMailReadPush } from '../../lib/read-push';
import { emailEventData, checkAccountAccess } from '@weldsuite/mail-domain/access';
import { workspaceMailFromContext } from '../../lib/mail-store-context';
import { SYSTEM_LABELS } from '@weldsuite/mail-domain/store/model';
import { and, inArray, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type {
  FlagPatch,
  MailAccess,
  MailboxOp,
  MailMessageListRow,
  MessageCursor,
  MessageListQuery,
  MailStoreMode,
  WorkspaceMailStore,
} from '@weldsuite/mail-domain/store';

// Inline rather than importing from `@weldsuite/app-api-client`, which would
// pull a client dep into the server (the client depends on the server's
// wire shape, not the other way around).
const forwardAttachmentSchema = z.object({
  filename: z.string().min(1).max(500),
  contentType: z.string().max(255).optional(),
  size: z.number().int().nonnegative(),
  fileKey: z.string().min(1),
});

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type AppContext = import('hono').Context<{ Bindings: Env; Variables: Variables }>;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const boolParam = z
  .string()
  .transform((v) => v === 'true')
  .optional();

const listQuery = z.object({
  accountId: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  cursor: z.string().optional(),
  search: z.string().optional(),
  isRead: boolParam,
  isStarred: boolParam,
  isFlagged: boolParam,
  hasAttachments: boolParam,
  threadId: z.string().optional(),
  label: z.string().optional(),
  /** Exact address match — the CRM Emails tab (design §5). */
  counterparty: z.string().min(1).optional(),
});

const updateBody = z.object({
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  isFlagged: z.boolean().optional(),
  isImportant: z.boolean().optional(),
  isSpam: z.boolean().optional(),
  isTrash: z.boolean().optional(),
  threadId: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

const bulkBody = z.object({
  messageIds: z.array(z.string()).min(1).max(100),
  action: z.enum([
    'markRead', 'markUnread', 'star', 'unstar', 'flag', 'unflag',
    'trash', 'restore', 'delete',
  ]),
});

/** Bulk actions after which a message's new-email banner should go. */
const BULK_ACTIONS_CLEARING_BANNER = new Set<z.infer<typeof bulkBody>['action']>(['markRead', 'trash', 'delete']);

/** messageId → accountId, regrouped as accountId → messageIds. */
function groupByAccount(accountByMessage: Map<string, string>): Map<string, string[]> {
  const byAccount = new Map<string, string[]>();
  for (const [messageId, accountId] of accountByMessage) {
    const ids = byAccount.get(accountId) ?? [];
    ids.push(messageId);
    byAccount.set(accountId, ids);
  }
  return byAccount;
}

const labelsBody = z.object({
  labels: z.array(z.string()).min(1),
});

const replyBody = z.object({
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  replyAll: z.boolean().default(false),
  attachments: z.array(forwardAttachmentSchema).optional(),
});

const forwardBody = z.object({
  to: z.array(z.string().email()).min(1),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  attachments: z.array(forwardAttachmentSchema).optional(),
  excludeAttachmentIds: z.array(z.string()).max(100).optional(),
  asAttachment: z.boolean().optional(),
  timeZone: z.string().max(64).optional(),
  locale: z.string().max(35).optional(),
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The legacy ~24-column list projection the route has always serialized (messages.ts's own `listMessagesWide` doc comment: "`listMessages` itself is left untouched so today's route keeps its exact response shape") — picked from the store's wider `MailMessageListRow` so postgres-mode list responses stay byte-identical. */
function toLegacyListItem(row: MailMessageListRow) {
  const {
    id, accountId, messageId, threadId, from, to, cc, subject, preview,
    sentDate, receivedDate, isRead, isStarred, isFlagged, isImportant, isDraft,
    hasAttachments, attachmentCount, priority, labels, sizeBytes, scheduledFor,
    sendStatus, createdAt,
  } = row;
  return {
    id, accountId, messageId, threadId, from, to, cc, subject, preview,
    sentDate, receivedDate, isRead, isStarred, isFlagged, isImportant, isDraft,
    hasAttachments, attachmentCount, priority, labels, sizeBytes, scheduledFor,
    sendStatus, createdAt,
  };
}

/**
 * The bare message-id cursor the platform/mobile clients have always sent and
 * received (today's `messages.listMessages`: look the id up, page strictly
 * before its `sentDate`). Resolved by locating the id's mailbox within the
 * accounts already in scope — a cursor id outside that scope (a message that
 * never existed, or was never reachable) simply starts the list over rather
 * than reproducing the legacy unscoped-by-access lookup, which no caller
 * actually depends on: every cursor a client holds came from a message this
 * same endpoint already served it.
 *
 * `includeDeleted: true` because the message the cursor points at may have
 * been deleted (by this client or another) since the page it came from was
 * served — the row is only used for its `sentDate` sort position, never
 * returned to the caller, so resolving it here doesn't mean the row is
 * listed. Without this, the deleted message resolves to nothing and the
 * "page not found" fallback above silently restarts the list at page 1.
 */
async function resolveLegacyCursor(
  store: WorkspaceMailStore,
  accountIds: string[],
  cursorId: string | undefined,
): Promise<MessageCursor | undefined> {
  if (!cursorId || accountIds.length === 0) return undefined;
  const ownerId =
    accountIds.length === 1
      ? accountIds[0]!
      : (await store.locateMessages([cursorId], accountIds, undefined, { includeDeleted: true })).get(cursorId);
  if (!ownerId) return undefined;
  const [row] = await store.mailbox(ownerId).getMessages([cursorId], { includeDeleted: true });
  if (!row?.sentDate) return undefined;
  return { sentAt: new Date(row.sentDate).getTime(), id: cursorId };
}

/**
 * The three ways a message list is answered: the CRM Emails tab's
 * cross-mailbox counterparty fan-in, a single mailbox's own list, or the
 * fanned-out union across every accessible mailbox.
 */
async function fetchMessagesPage(
  store: WorkspaceMailStore,
  accountIds: string[],
  query: MessageListQuery,
  counterparty: string | undefined,
  cursor: MessageCursor | undefined,
  limit: number,
) {
  if (counterparty) {
    // CRM Emails tab: the dedicated cross-mailbox fan-in, so object mode
    // can narrow via the ledger's address index instead of fanning out
    // to every accessible mailbox (design §5).
    return store.messagesByCounterparty(counterparty, accountIds, { cursor, limit });
  }
  if (accountIds.length === 1) {
    return store.mailbox(accountIds[0]!).listMessages(query);
  }
  return store.listMessages(accountIds, query);
}

type LocateResult = { ok: true; accountId: string } | { ok: false; response: Response };

/**
 * Finds the mailbox a message/attachment/draft belongs to among the accounts
 * the caller may open (`WorkspaceMailStore.locateMessages`'s `hint`, design
 * §5's "Locate"). `postgres`/`shadow` fall back to a true (access-unscoped)
 * existence check so the 403-vs-404 distinction today's routes make stays
 * exactly as it is; `object`/`object-only` collapse both cases to 404 (design
 * §5: "a message outside the caller's reach is a 404, where today it is a
 * 403 — no existence leak").
 */
async function locateMessageOrRespond(
  c: AppContext,
  db: Database,
  store: WorkspaceMailStore,
  access: MailAccess,
  mode: MailStoreMode,
  id: string,
  hint: string | undefined,
  resource: string,
): Promise<LocateResult> {
  const accessibleIds = await access.accessibleAccountIds();
  if (accessibleIds.length > 0) {
    const located = await store.locateMessages([id], accessibleIds, hint);
    const accountId = located.get(id);
    if (accountId) return { ok: true, accountId };
  }
  if (mode === 'postgres' || mode === 'shadow') {
    const trueAccountId = await messages.getMessageAccountId(db, id);
    if (!trueAccountId) return { ok: false, response: error.notFound(c, resource, id) };
    return { ok: false, response: error.forbidden(c, 'Access to this mail account is not allowed') };
  }
  return { ok: false, response: error.notFound(c, resource, id) };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/', requirePermission('messages:read'), zValidator('query', listQuery), async (c) => {
  try {
    const filters = c.req.valid('query');
    const { store, access } = await workspaceMailFromContext(c);

    let accountIds: string[];
    if (filters.accountId) {
      if (!(await access.canOpen(filters.accountId))) {
        return error.forbidden(c, 'Access to this mail account is not allowed');
      }
      accountIds = [filters.accountId];
    } else {
      // Admins get no blanket pass: a private mailbox is only in scope for
      // the users assigned to it.
      accountIds = await access.accessibleAccountIds();
      if (accountIds.length === 0) return list(c, [], cursorPagination(0, false, null));
    }

    const limit = filters.limit ?? 50;
    const cursor = await resolveLegacyCursor(store, accountIds, filters.cursor);
    const query: MessageListQuery = {
      limit,
      cursor,
      search: filters.search,
      isRead: filters.isRead,
      isStarred: filters.isStarred,
      isFlagged: filters.isFlagged,
      hasAttachments: filters.hasAttachments,
      threadId: filters.threadId,
      label: filters.label,
    };

    const result = await fetchMessagesPage(store, accountIds, query, filters.counterparty, cursor, limit);

    const data = result.data.map(toLegacyListItem);
    const nextCursorId = result.nextCursor?.id ?? null;
    return list(c, data, cursorPagination(result.totalCount, nextCursorId !== null, nextCursorId));
  } catch (err) {
    console.error('[app-api/mail-messages] list failed:', err);
    return error.internal(c, 'Failed to list mail messages');
  }
});

app.get('/stats', requirePermission('messages:read'), async (c) => {
  try {
    const accountId = c.req.query('accountId');
    const { store, access } = await workspaceMailFromContext(c);
    if (accountId) {
      if (!(await access.canOpen(accountId))) {
        return error.forbidden(c, 'Access to this mail account is not allowed');
      }
      return success(c, await store.mailbox(accountId).stats());
    }
    // Unified counters cover the mailboxes the caller may open, like the
    // unified list above — never every mailbox in the workspace.
    const accessibleAccountIds = await access.accessibleAccountIds();
    const stats = await store.stats(accessibleAccountIds);
    return success(c, stats);
  } catch (err) {
    console.error('[app-api/mail-messages] stats failed:', err);
    return error.internal(c, 'Failed to fetch message stats');
  }
});

app.get('/:id', requirePermission('messages:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const { store, access, mode } = await workspaceMailFromContext(c);
    const located = await locateMessageOrRespond(c, db, store, access, mode, id, c.req.query('accountId'), 'Message');
    if (!located.ok) return located.response;
    const row = await store.mailbox(located.accountId).getMessage(id, { bodies: true, attachments: true });
    if (!row) return error.notFound(c, 'Message', id);
    // Attachment rows without their storage URL: files are read through
    // GET /api/mail-attachments/:id/download, which checks the mailbox.
    return success(c, {
      ...row,
      attachments: (row.attachments ?? []).filter((a) => !a.deletedAt).map(toPublicAttachment),
    });
  } catch (err) {
    console.error('[app-api/mail-messages] get failed:', err);
    return error.internal(c, 'Failed to fetch message');
  }
});

app.get('/:id/thread', requirePermission('messages:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const { store, access, mode } = await workspaceMailFromContext(c);
    const located = await locateMessageOrRespond(c, db, store, access, mode, id, c.req.query('accountId'), 'Thread for message');
    if (!located.ok) return located.response;
    const thread = await store.mailbox(located.accountId).getThreadOfMessage(id);
    if (!thread) return error.notFound(c, 'Thread for message', id);
    return success(c, thread);
  } catch (err) {
    console.error('[app-api/mail-messages] thread failed:', err);
    return error.internal(c, 'Failed to fetch thread');
  }
});

/** The flag keys `updateBody` may carry, in the shape `MailboxOp`'s `flags` op wants. */
function flagPatchFrom(data: z.infer<typeof updateBody>): FlagPatch {
  const patch: FlagPatch = {};
  if (data.isRead !== undefined) patch.isRead = data.isRead;
  if (data.isStarred !== undefined) patch.isStarred = data.isStarred;
  if (data.isFlagged !== undefined) patch.isFlagged = data.isFlagged;
  if (data.isImportant !== undefined) patch.isImportant = data.isImportant;
  if (data.isSpam !== undefined) patch.isSpam = data.isSpam;
  if (data.isTrash !== undefined) patch.isTrash = data.isTrash;
  return patch;
}

const patchHandler = async (
  c: AppContext,
  id: string,
  data: z.infer<typeof updateBody>,
) => {
  const db = c.get('tenantDb');
  const { store, access, mode } = await workspaceMailFromContext(c);
  const located = await locateMessageOrRespond(c, db, store, access, mode, id, c.req.query('accountId'), 'Message');
  if (!located.ok) return located.response;
  const accountId = located.accountId;

  // `updateMessage` always applied flags + explicit labels + a threadId move
  // as one atomic UPDATE; the store exposes them as separate ops (one LWW
  // clock group each, design §3.2), applied in the same order flags-then-
  // labels-then-thread so an explicit `labels` always wins the final row,
  // same as today's "explicit labels skips the flag-derived label sync".
  const ops: MailboxOp[] = [{ kind: 'flags', ids: [id], patch: flagPatchFrom(data), semantics: 'single' }];
  if (data.labels !== undefined) ops.push({ kind: 'labels.set', id, labels: data.labels });
  if (data.threadId !== undefined) ops.push({ kind: 'thread.set', id, threadId: data.threadId });

  const results = await store.mailbox(accountId).applyBatch(ops);
  if (results.some((r) => r.missing.includes(id))) return error.notFound(c, 'Message', id);

  const [after] = await store.mailbox(accountId).getMessages([id]);
  publishEntityEvent({
    c,
    entityType: 'email',
    entityId: id,
    action: 'updated',
    data: await emailEventData(db, {
      id,
      accountId,
      subject: after?.subject ?? null,
      from: (after?.from as { email?: string } | null)?.email ?? null,
      to: (after?.to as { email?: string }[] | null)?.map((t) => t.email ?? '').filter(Boolean) ?? null,
    }),
  });
  if (clearsUnreadBanner(data)) queueMailReadPush(c, accountId, [id]);
  return success(c, { id, ...data });
};

// PUT and PATCH share an identical body — keeping both verbs registered
// preserves wire compatibility with the legacy api-worker surface.
const updateRoute = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }, '/:id'>,
) => {
  try {
    return await patchHandler(c, c.req.param('id'), c.req.valid('json' as never) as z.infer<typeof updateBody>);
  } catch (err) {
    console.error('[app-api/mail-messages] update failed:', err);
    return error.internal(c, 'Failed to update message');
  }
};

app.put('/:id', requirePermission('messages:update'), zValidator('json', updateBody), updateRoute);
app.patch('/:id', requirePermission('messages:update'), zValidator('json', updateBody), updateRoute);

/** `BulkAction` → the `MailboxOp` it compiles to (design §1: "compiled to flags/labels.add/labels.remove/move/delete per mailbox after locateMessages"). */
function bulkOpFor(action: z.infer<typeof bulkBody>['action'], ids: string[]): MailboxOp {
  switch (action) {
    case 'markRead':
      return { kind: 'flags', ids, patch: { isRead: true }, semantics: 'bulk' };
    case 'markUnread':
      return { kind: 'flags', ids, patch: { isRead: false }, semantics: 'bulk' };
    case 'star':
      return { kind: 'labels.add', ids, labels: [SYSTEM_LABELS.STARRED], semantics: 'bulk' };
    case 'unstar':
      return { kind: 'labels.remove', ids, labels: [SYSTEM_LABELS.STARRED], semantics: 'bulk' };
    case 'flag':
      return { kind: 'flags', ids, patch: { isFlagged: true }, semantics: 'bulk' };
    case 'unflag':
      return { kind: 'flags', ids, patch: { isFlagged: false }, semantics: 'bulk' };
    case 'trash':
      return { kind: 'move', ids, location: SYSTEM_LABELS.TRASH };
    case 'restore':
      return { kind: 'move', ids, location: SYSTEM_LABELS.INBOX };
    case 'delete':
      return { kind: 'delete', ids, hard: false };
  }
}

/**
 * Every id's TRUE account, regardless of the caller's access — the one raw
 * query this route keeps: `WorkspaceMailStore.locateMessages` is deliberately
 * scoped to accounts the caller may already open, so it cannot answer "does
 * this id belong to a mailbox I'm NOT allowed to see" the way the `postgres`/
 * `shadow` all-or-nothing bulk check needs to (see `locateMessageOrRespond`'s
 * doc comment for the same distinction on the single-message routes).
 */
async function locateAllByIdRegardlessOfAccess(db: Database, messageIds: string[]): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: schema.mailMessages.id, accountId: schema.mailMessages.accountId })
    .from(schema.mailMessages)
    .where(and(inArray(schema.mailMessages.id, messageIds), isNull(schema.mailMessages.deletedAt)));
  return new Map(rows.map((r) => [r.id, r.accountId]));
}

app.post(
  '/bulk',
  requirePermission('messages:update'),
  zValidator('json', bulkBody),
  async (c) => {
    const data = c.req.valid('json');
    const db = c.get('tenantDb');
    try {
      const { store, access, mode } = await workspaceMailFromContext(c);
      let accountByMessage: Map<string, string>;

      if (mode === 'postgres' || mode === 'shadow') {
        // Same all-or-nothing check today's route makes: resolve every id's
        // TRUE account (regardless of access — an existing bulk request must
        // not silently drop a message it isn't allowed to touch) and refuse
        // the whole batch if any of them is closed to the caller.
        accountByMessage = await locateAllByIdRegardlessOfAccess(db, data.messageIds);
        for (const accountId of new Set(accountByMessage.values())) {
          if (!(await access.canOpen(accountId))) {
            return error.forbidden(c, 'Access to one or more mail accounts is not allowed');
          }
        }
      } else {
        // object/object-only: no existence leak — ids outside the caller's
        // reach are silently left out of the batch rather than failing it.
        const accessibleIds = await access.accessibleAccountIds();
        accountByMessage = await store.locateMessages(data.messageIds, accessibleIds);
      }

      for (const [accountId, ids] of groupByAccount(accountByMessage)) {
        await store.mailbox(accountId).apply(bulkOpFor(data.action, ids));
      }
      // `bulkUpdateMessages` always answered with the requested count, not the
      // count of rows actually matched — kept as-is, not a behaviour this task
      // changes.
      const affected = data.messageIds.length;

      // One hub event is enough — platformSyncMap invalidates the whole
      // `['mail']` prefix. Avoid enqueueing N hub messages for a bulk of 100.
      const anchorId = data.messageIds[0]!;
      const anchorAccountId = accountByMessage.get(anchorId) ?? '';
      publishEntityEvent({
        c,
        entityType: 'email',
        entityId: anchorId,
        action: data.action === 'delete' ? 'deleted' : 'updated',
        data: {
          id: anchorId,
          accountId: anchorAccountId,
          subject: null,
          from: null,
          to: null,
        },
      });
      if (BULK_ACTIONS_CLEARING_BANNER.has(data.action)) {
        for (const [accId, ids] of groupByAccount(accountByMessage)) queueMailReadPush(c, accId, ids);
      }
      return success(c, { affected });
    } catch (err) {
      console.error('[app-api/mail-messages] bulk failed:', err);
      return error.internal(c, 'Failed to apply bulk action');
    }
  },
);

app.delete('/:id', requirePermission('messages:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const { store, access, mode } = await workspaceMailFromContext(c);
    const located = await locateMessageOrRespond(c, db, store, access, mode, id, c.req.query('accountId'), 'Message');
    if (!located.ok) return located.response;
    const accountId = located.accountId;
    const [before] = await store.mailbox(accountId).getMessages([id]);
    const result = await store.mailbox(accountId).apply({ kind: 'delete', ids: [id], hard: false });
    if (!result.applied.includes(id)) return error.notFound(c, 'Message', id);
    publishEntityEvent({
      c,
      entityType: 'email',
      entityId: id,
      action: 'deleted',
      data: await emailEventData(db, {
        id,
        accountId,
        subject: before?.subject ?? null,
        from: null,
        to: null,
      }),
    });
    queueMailReadPush(c, accountId, [id]);
    return noContent(c);
  } catch (err) {
    console.error('[app-api/mail-messages] delete failed:', err);
    return error.internal(c, 'Failed to delete message');
  }
});

app.post(
  '/:id/labels/add',
  requirePermission('messages:update'),
  zValidator('json', labelsBody),
  async (c) => {
    const id = c.req.param('id');
    try {
      const db = c.get('tenantDb');
      const { store, access, mode } = await workspaceMailFromContext(c);
      const located = await locateMessageOrRespond(c, db, store, access, mode, id, c.req.query('accountId'), 'Message');
      if (!located.ok) return located.response;
      const result = await store.mailbox(located.accountId).apply({
        kind: 'labels.add',
        ids: [id],
        labels: c.req.valid('json').labels,
        semantics: 'single',
      });
      if (!result.applied.includes(id)) return error.notFound(c, 'Message', id);
      publishEntityEvent({
        c,
        entityType: 'email',
        entityId: id,
        action: 'updated',
        data: { id, accountId: located.accountId, subject: null, from: null, to: null },
      });
      return success(c, { id, labels: result.labels?.[id] ?? [] });
    } catch (err) {
      console.error('[app-api/mail-messages] add-labels failed:', err);
      return error.internal(c, 'Failed to add labels');
    }
  },
);

app.post(
  '/:id/labels/remove',
  requirePermission('messages:update'),
  zValidator('json', labelsBody),
  async (c) => {
    const id = c.req.param('id');
    try {
      const db = c.get('tenantDb');
      const { store, access, mode } = await workspaceMailFromContext(c);
      const located = await locateMessageOrRespond(c, db, store, access, mode, id, c.req.query('accountId'), 'Message');
      if (!located.ok) return located.response;
      const result = await store.mailbox(located.accountId).apply({
        kind: 'labels.remove',
        ids: [id],
        labels: c.req.valid('json').labels,
        semantics: 'single',
      });
      if (!result.applied.includes(id)) return error.notFound(c, 'Message', id);
      publishEntityEvent({
        c,
        entityType: 'email',
        entityId: id,
        action: 'updated',
        data: { id, accountId: located.accountId, subject: null, from: null, to: null },
      });
      return success(c, { id, labels: result.labels?.[id] ?? [] });
    } catch (err) {
      console.error('[app-api/mail-messages] remove-labels failed:', err);
      return error.internal(c, 'Failed to remove labels');
    }
  },
);

/**
 * POST /:id/reply — send a reply to a message. Routed through the
 * Cloudflare `send_email` binding via the shared send helper.
 *
 * The access check (`getMessageAccountId` + `checkAccountAccess`) stays the
 * direct-Postgres calls it always was — `MailAccess` is the object-mode
 * replacement for a different task, and `mail_accounts`/`workspace_members`
 * are never moved into the mailbox store (design docs/plans/
 * weldmail-mailbox-store-design.md §6/§9 task D1). Once the account is known,
 * the send itself goes through its mailbox's store: `sendAndPersist`/
 * `replyAndPersist` accept it as an optional `store` and fall back to
 * direct Postgres when it's absent (callers that cannot resolve one yet).
 */
app.post(
  '/:id/reply',
  requirePermission('messages:create'),
  zValidator('json', replyBody),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);
    const id = c.req.param('id');
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const accountId = await messages.getMessageAccountId(db, id);
    if (!accountId) return error.notFound(c, 'Message', id);
    const allowed = await checkAccountAccess(db, accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const data = c.req.valid('json');
    try {
      const { store, mode } = await workspaceMailFromContext(c);
      const result = await replyAndPersist(
        c.env,
        db,
        orgId,
        userId,
        id,
        data,
        {
          waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx),
          store: store.mailbox(accountId),
          mailStoreMode: mode,
        },
      );
      publishEntityEvent({
        c,
        entityType: 'email',
        entityId: result.messageId,
        action: 'reply_sent',
        data: await emailEventData(db, {
          id: result.messageId,
          accountId: result.accountId,
          subject: result.subject,
          from: null,
          to: null,
          conversationId: result.repliedTo,
        }),
      });
      return success(c, {
        messageId: result.messageId,
        smtpMessageId: result.smtpMessageId,
        pendingVerification: result.pendingVerification,
        repliedTo: result.repliedTo,
      });
    } catch (err) {
      if (err instanceof MailSendError) return sendErrorResponse(c, err, { resource: 'Message', id });
      console.error('[app-api/mail-messages] reply failed:', err);
      return error.internal(c, 'Failed to send reply');
    }
  },
);

/**
 * POST /:id/forward — send a forwarded copy of a message to fresh
 * recipients. Inherits no thread metadata (it's a new conversation for
 * the new recipients); the original body is quoted into both text and
 * html parts.
 *
 * The access check stays direct Postgres (see `/reply`'s doc comment above);
 * the send itself goes through the store.
 */
app.post(
  '/:id/forward',
  requirePermission('messages:create'),
  zValidator('json', forwardBody),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);
    const id = c.req.param('id');
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const accountId = await messages.getMessageAccountId(db, id);
    if (!accountId) return error.notFound(c, 'Message', id);
    const allowed = await checkAccountAccess(db, accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const data = c.req.valid('json');
    try {
      const { store, mode } = await workspaceMailFromContext(c);
      const result = await forwardAndPersist(
        c.env,
        db,
        orgId,
        userId,
        id,
        data,
        {
          waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx),
          // The master workspace id (already resolved by workspaceDbMiddleware)
          // lets a "forward as attachment" read the original's raw MIME from
          // R2 instead of rebuilding it.
          outbound: { workspaceId: c.get('workspaceId') },
          store: store.mailbox(accountId),
          mailStoreMode: mode,
        },
      );
      publishEntityEvent({
        c,
        entityType: 'email',
        entityId: result.messageId,
        action: 'email_sent',
        data: await emailEventData(db, {
          id: result.messageId,
          accountId: result.accountId,
          subject: result.subject,
          from: null,
          to: data.to,
          conversationId: result.forwardedFrom,
        }),
      });
      return success(c, {
        messageId: result.messageId,
        smtpMessageId: result.smtpMessageId,
        pendingVerification: result.pendingVerification,
        forwardedFrom: result.forwardedFrom,
      });
    } catch (err) {
      if (err instanceof MailSendError) return sendErrorResponse(c, err, { resource: 'Message', id });
      console.error('[app-api/mail-messages] forward failed:', err);
      return error.internal(c, 'Failed to forward email');
    }
  },
);

export const mailMessagesRoutes = app;
