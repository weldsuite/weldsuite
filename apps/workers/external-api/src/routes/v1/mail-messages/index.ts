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
 *
 * Reads and organize ops go through `getWorkspaceMail`'s `store`/`access`
 * (design docs/plans/weldmail-mailbox-store-design.md, task D5), via
 * `../../../lib/mail-store-context`'s `workspaceMailFromContext`, so this
 * route works the same in every mailbox-store mode. A message outside the
 * caller's reach is a 404 in every mode — this surface never answered 403 for
 * "exists, but closed to you" (no existence leak), so there is no
 * postgres-vs-object branching to make here unlike the platform's own routes.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { emailEventData } from '@weldsuite/mail-domain/access';
import { isLocationLabel, normalizeLabel, SYSTEM_LABELS } from '@weldsuite/mail-domain/labels';
import type {
  FlagPatch,
  MailboxOp,
  MessageCursor,
  MessageListQuery,
  WorkspaceMailStore,
} from '@weldsuite/mail-domain/store';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { parseBoolFlag, publicAttachment, publicListMessage, publicMessage } from '../../../lib/mail';
import { workspaceMailFromContext } from '../../../lib/mail-store-context';

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

const LOCATIONS = {
  inbox: SYSTEM_LABELS.INBOX,
  archive: SYSTEM_LABELS.ARCHIVE,
  trash: SYSTEM_LABELS.TRASH,
  spam: SYSTEM_LABELS.SPAM,
} as const;

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
async function reachableAccountId(store: WorkspaceMailStore, accessibleIds: string[], id: string): Promise<string | null> {
  if (accessibleIds.length === 0) return null;
  return (await store.locateMessages([id], accessibleIds)).get(id) ?? null;
}

/**
 * The bare message-id cursor this surface has always sent and received (the
 * legacy `listMessages`: look the id up, page strictly before its
 * `sentDate`). Resolved by locating the id's mailbox within the accounts
 * already in scope — a cursor id outside that scope simply starts the list
 * over rather than reproducing an unscoped-by-access lookup, which no caller
 * actually depends on: every cursor a client holds came from a message this
 * same endpoint already served it.
 */
async function resolveLegacyCursor(
  store: WorkspaceMailStore,
  accountIds: string[],
  cursorId: string | undefined,
): Promise<MessageCursor | undefined> {
  if (!cursorId || accountIds.length === 0) return undefined;
  const ownerId =
    accountIds.length === 1 ? accountIds[0]! : (await store.locateMessages([cursorId], accountIds)).get(cursorId);
  if (!ownerId) return undefined;
  const [row] = await store.mailbox(ownerId).getMessages([cursorId]);
  if (!row?.sentDate) return undefined;
  return { sentAt: new Date(row.sentDate).getTime(), id: cursorId };
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
  const q = c.req.valid('query');
  const { store, access } = await workspaceMailFromContext(c);

  let accountIds: string[];
  if (q.accountId) {
    if (!(await access.canOpen(q.accountId))) return error.notFound(c, 'MailAccount', q.accountId);
    accountIds = [q.accountId];
  } else {
    accountIds = await access.accessibleAccountIds();
    if (accountIds.length === 0) return list(c, [], cursorPagination(0, false, null));
  }

  const label = q.label ? normalizeLabel(q.label) : undefined;
  const cursor = await resolveLegacyCursor(store, accountIds, q.cursor);
  const query: MessageListQuery = {
    limit: q.limit ?? 50,
    cursor,
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
  };
  const result =
    accountIds.length === 1
      ? await store.mailbox(accountIds[0]!).listMessages(query)
      : await store.listMessages(accountIds, query);

  const data = result.data.map(publicListMessage);
  const nextCursorId = result.nextCursor?.id ?? null;
  return list(c, data, cursorPagination(result.totalCount, nextCursorId !== null, nextCursorId));
});

app.post('/bulk', requireScope('mail_messages:write'), zValidator('json', bulkBody), async (c) => {
  const { ids, action } = c.req.valid('json');
  const unique = [...new Set(ids)];
  const { store, access } = await workspaceMailFromContext(c);

  // Every id must be a live message in a mailbox the caller can open; one that
  // isn't fails the whole request rather than being silently skipped (no
  // existence leak either way — both "doesn't exist" and "not yours" land
  // here as a `locateMessages` miss).
  const accessibleIds = await access.accessibleAccountIds();
  const accountOf = await store.locateMessages(unique, accessibleIds);
  const missing = unique.find((id) => !accountOf.has(id));
  if (missing) return error.notFound(c, 'Message', missing);

  const byAccount = new Map<string, string[]>();
  for (const [id, accountId] of accountOf) {
    const forAccount = byAccount.get(accountId) ?? [];
    forAccount.push(id);
    byAccount.set(accountId, forAccount);
  }
  for (const [accountId, accountMessageIds] of byAccount) {
    await store.mailbox(accountId).apply(bulkOpFor(action, accountMessageIds));
  }

  for (const id of unique) publishIdOnly(c, id, accountOf.get(id)!, action === 'delete' ? 'deleted' : 'updated');
  return success(c, { affected: unique.length, action });
});

/** `BulkAction` → the `MailboxOp` it compiles to, one call per mailbox. */
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
    case 'archive':
      return { kind: 'move', ids, location: SYSTEM_LABELS.ARCHIVE };
    case 'spam':
      return { kind: 'move', ids, location: SYSTEM_LABELS.SPAM };
    case 'trash':
      return { kind: 'move', ids, location: SYSTEM_LABELS.TRASH };
    case 'restore':
      return { kind: 'move', ids, location: SYSTEM_LABELS.INBOX };
    case 'delete':
      return { kind: 'delete', ids, hard: false };
  }
}

app.get('/:id', requireScope('mail_messages:read'), zValidator('query', getQuery), async (c) => {
  const id = c.req.param('id');
  const { store, access } = await workspaceMailFromContext(c);
  const accountId = await reachableAccountId(store, await access.accessibleAccountIds(), id);
  if (!accountId) return error.notFound(c, 'Message', id);
  const row = await store.mailbox(accountId).getMessage(id, { bodies: true, attachments: true });
  if (!row) return error.notFound(c, 'Message', id);
  const { attachments, ...message } = row;
  const textOnly = c.req.valid('query').includeHtml === 'false' && !!message.textBody?.trim();
  return success(c, {
    ...publicMessage(message),
    ...(textOnly ? { htmlBody: null } : {}),
    attachments: (attachments ?? []).filter((a) => !a.deletedAt).map(publicAttachment),
  });
});

app.get('/:id/attachments', requireScope('mail_attachments:read'), async (c) => {
  const id = c.req.param('id');
  const { store, access } = await workspaceMailFromContext(c);
  const accountId = await reachableAccountId(store, await access.accessibleAccountIds(), id);
  if (!accountId) return error.notFound(c, 'Message', id);
  const rows = await store.mailbox(accountId).listAttachments(id);
  return list(c, rows.map(publicAttachment), cursorPagination(rows.length, false, null));
});

/** The flag keys `updateBody` may carry, in the shape `MailboxOp`'s `flags` op wants. */
function flagPatchFrom(data: z.infer<typeof updateBody>): FlagPatch {
  const patch: FlagPatch = {};
  if (data.isRead !== undefined) patch.isRead = data.isRead;
  if (data.isStarred !== undefined) patch.isStarred = data.isStarred;
  if (data.isFlagged !== undefined) patch.isFlagged = data.isFlagged;
  if (data.isImportant !== undefined) patch.isImportant = data.isImportant;
  return patch;
}

app.patch('/:id', requireScope('mail_messages:write'), zValidator('json', updateBody), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { store, access } = await workspaceMailFromContext(c);
  const accountId = await reachableAccountId(store, await access.accessibleAccountIds(), id);
  if (!accountId) return error.notFound(c, 'Message', id);
  const data = c.req.valid('json');
  const result = await store
    .mailbox(accountId)
    .apply({ kind: 'flags', ids: [id], patch: flagPatchFrom(data), semantics: 'single' });
  if (!result.applied.includes(id)) return error.notFound(c, 'Message', id);
  const after = await store.mailbox(accountId).getMessage(id, { bodies: true });
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
  return success(c, publicMessage(after!));
});

app.post('/:id/labels', requireScope('mail_messages:write'), zValidator('json', labelsBody), async (c) => {
  const id = c.req.param('id');
  const { store, access } = await workspaceMailFromContext(c);
  const accountId = await reachableAccountId(store, await access.accessibleAccountIds(), id);
  if (!accountId) return error.notFound(c, 'Message', id);

  const body = c.req.valid('json');
  const add = (body.add ?? []).map(normalizeLabel);
  const remove = (body.remove ?? []).map(normalizeLabel);
  const location = [...add, ...remove].find(isLocationLabel);
  if (location) {
    return error.badRequest(c, `${location} is a location, not a label. Use POST /v1/mail-messages/${id}/move.`);
  }

  // Existence/applied comes from `result.applied` (populated by every backend);
  // the labels VALUE to report is read from wherever the backend put it —
  // `result.labels[id]` (postgres) or the full `result.message.labels` (the
  // object store's single-id label ops return the row instead of a labels
  // map; see the task report's "store API gaps"). Conflating "no labels map"
  // with "not found", the way a naive `labels === null` check would, 404s a
  // successful object-mode write.
  let applied = false;
  let labels: string[] = [];
  if (add.length) {
    const result = await store.mailbox(accountId).apply({ kind: 'labels.add', ids: [id], labels: add, semantics: 'single' });
    if (result.applied.includes(id)) applied = true;
    labels = result.labels?.[id] ?? (result.message?.labels as string[] | null | undefined) ?? labels;
  }
  if (remove.length) {
    const result = await store
      .mailbox(accountId)
      .apply({ kind: 'labels.remove', ids: [id], labels: remove, semantics: 'single' });
    if (result.applied.includes(id)) applied = true;
    labels = result.labels?.[id] ?? (result.message?.labels as string[] | null | undefined) ?? labels;
  }
  if (!applied) return error.notFound(c, 'Message', id);

  publishIdOnly(c, id, accountId, 'updated');
  return success(c, { id, labels });
});

app.post('/:id/move', requireScope('mail_messages:write'), zValidator('json', moveBody), async (c) => {
  const id = c.req.param('id');
  const { store, access } = await workspaceMailFromContext(c);
  const accountId = await reachableAccountId(store, await access.accessibleAccountIds(), id);
  if (!accountId) return error.notFound(c, 'Message', id);
  const { location } = c.req.valid('json');
  await store.mailbox(accountId).apply({ kind: 'move', ids: [id], location: LOCATIONS[location] });
  publishIdOnly(c, id, accountId, 'updated');
  return success(c, { id, location });
});

app.delete('/:id', requireScope('mail_messages:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { store, access } = await workspaceMailFromContext(c);
  const accountId = await reachableAccountId(store, await access.accessibleAccountIds(), id);
  if (!accountId) return error.notFound(c, 'Message', id);
  const [before] = await store.mailbox(accountId).getMessages([id]);
  const result = await store.mailbox(accountId).apply({ kind: 'delete', ids: [id], hard: false });
  if (!result.applied.includes(id)) return error.notFound(c, 'Message', id);
  publishEntityEvent({
    c,
    entityType: 'email',
    entityId: id,
    action: 'deleted',
    data: await emailEventData(db, { id, accountId, subject: before?.subject ?? null, from: null, to: null }),
  });
  return noContent(c);
});

export default app;
