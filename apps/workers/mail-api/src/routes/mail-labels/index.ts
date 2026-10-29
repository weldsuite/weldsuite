/**
 * Mail label routes — /api/mail-labels/*.
 *
 * Endpoints mirror the legacy api-worker surface, collapsing the four
 * separate route trees (`mailLabelsRoutes`, `mailAccountLabelsRoutes`,
 * `mailThreadLabelsRoutes`, `mailUnifiedLabelsRoutes`) into a flat
 * `/api/mail-labels/*` namespace consistent with the rest of app-api.
 *
 * - CRUD on the `mail_labels` table (per-account; uniqueness enforced
 *   case-insensitively per account). Label definitions stay on Postgres in
 *   every mode (design docs/plans/weldmail-mailbox-store-design.md, task D2);
 *   the KV mailbox directory is bumped after every write, and a rename/delete
 *   also mirrors the message-side relabel to the mailbox store in modes that
 *   read from it (`updateMailLabel`/`deleteMailLabel` already relabel/strip
 *   on Postgres in one atomic statement — unchanged, so `postgres` mode is
 *   byte-identical; the `label.rename`/`label.delete` ops below only run
 *   alongside that in `shadow`/`object`/`object-only`, so the object's own
 *   copy learns about the change too).
 * - Bulk apply/unapply against message labels, and thread-scoped apply/
 *   unapply, through the store.
 * - Paginated threads-by-label, optionally restricted to one account
 *   (when `accountId` is supplied) or unified across every account the
 *   caller has access to (omit `accountId`), with the store's cursor
 *   alongside the legacy `page`/`pageSize`.
 *
 * Entity events: `mail_label:created | updated | deleted`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { inArray } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  createMailLabel,
  deleteMailLabel,
  getMailLabel,
  listMailLabels,
  MailLabelError,
  updateMailLabel,
} from '@weldsuite/mail-domain/labels';
import { workspaceMailFromContext } from '../../lib/mail-store-context';
import { bumpMailboxDirectory, type MailAccess, type ThreadListQuery, type WorkspaceMailStore } from '@weldsuite/mail-domain/store';
import { decodeThreadCursor, encodeThreadCursor } from '@weldsuite/mail-domain/store/cursor';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * True only if the caller may access every mail account the given messages
 * belong to. Guards the bulk message-label ops so labels can't be written onto
 * a private account's messages the caller isn't assigned to — the same
 * all-or-nothing shape `/api/mail-messages/bulk` keeps in `postgres`/`shadow`
 * (see that route's `locateAllByIdRegardlessOfAccess` doc comment): resolve
 * every id's TRUE account regardless of access, since `WorkspaceMailStore`'s
 * own `locateMessages` is deliberately scoped to what the caller may already
 * open and so cannot tell "exists, but closed to you" apart from "doesn't
 * exist".
 */
async function canAccessMessageAccounts(
  db: Database,
  access: MailAccess,
  messageIds: string[],
): Promise<boolean> {
  if (messageIds.length === 0) return true;
  const rows = await db
    .select({ accountId: schema.mailMessages.accountId })
    .from(schema.mailMessages)
    .where(inArray(schema.mailMessages.id, messageIds));
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  for (const accountId of accountIds) {
    if (!(await access.canOpen(accountId))) return false;
  }
  return true;
}

/** Every id's account, scoped to what the caller may open — for object/object-only, where an inaccessible id is simply left out rather than failing the whole request. */
async function accessibleMessageAccounts(
  store: WorkspaceMailStore,
  access: MailAccess,
  messageIds: string[],
): Promise<Map<string, string>> {
  const accessibleIds = await access.accessibleAccountIds();
  return store.locateMessages(messageIds, accessibleIds);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listQuery = z.object({
  accountId: z.string().optional(),
});

const createBody = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(100),
  color: z.string().max(20).optional(),
  aiEnabled: z.boolean().optional(),
  aiKeywords: z.array(z.string()).optional(),
  aiDescription: z.string().optional(),
  aiConfidence: z.number().int().min(0).max(100).optional(),
});

const updateBody = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().max(20).optional(),
  position: z.number().int().optional(),
  aiEnabled: z.boolean().optional(),
  aiKeywords: z.array(z.string()).optional(),
  aiDescription: z.string().optional(),
  aiConfidence: z.number().int().min(0).max(100).optional(),
});

const applyToMessagesBody = z.object({
  labelName: z.string().min(1),
  messageIds: z.array(z.string()).min(1).max(500),
});

const threadLabelBody = z.object({
  accountId: z.string().min(1),
  threadId: z.string().min(1),
  labelName: z.string().min(1),
  action: z.enum(['add', 'remove']),
});

const threadsQuery = z.object({
  accountId: z.string().optional(),
  labelSlug: z.string().min(1),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /** Store keyset cursor (design §5), alongside the legacy `page`/`pageSize`. */
  cursor: z.string().optional(),
  search: z.string().max(200).optional(),
  from: z.string().max(200).optional(),
  to: z.string().max(200).optional(),
  subject: z.string().max(200).optional(),
  /** "Doesn't have": leaves out threads where any message has any of these words. */
  excludeWords: z.string().max(200).optional(),
  hasAttachment: z
    .string()
    .transform((v) => v === 'true')
    .optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapLabelError(c: Parameters<typeof error.badRequest>[0], err: MailLabelError) {
  switch (err.code) {
    case 'DUPLICATE_NAME':
      return error.conflict(c, err.message);
    case 'NOT_FOUND':
      return error.notFound(c, 'Label');
    case 'SYSTEM_LABEL_IMMUTABLE':
      return error.forbidden(c, err.message);
  }
}

// ---------------------------------------------------------------------------
// Threads-by-label — declared before /:id so the path can't shadow it.
// ---------------------------------------------------------------------------

/**
 * GET /threads — paginated threads filtered by label.
 *
 * `accountId` query param restricts to one account; omit it to get the
 * unified inbox across every account the caller can read. An inaccessible or
 * unknown single `accountId` answers with an empty page (200), the same as
 * today's `listThreadsByLabel` — not a 403, since the route never had a
 * stand-alone access check here either.
 */
app.get(
  '/threads',
  requirePermission('messages:read'),
  zValidator('query', threadsQuery),
  async (c) => {
    const q = c.req.valid('query');
    try {
      const { store, access } = await workspaceMailFromContext(c);
      let accountIds: string[];
      if (q.accountId) {
        accountIds = (await access.canOpen(q.accountId)) ? [q.accountId] : [];
      } else {
        accountIds = await access.accessibleAccountIds();
      }
      if (accountIds.length === 0) {
        return success(c, { threads: [], totalCount: 0, nextCursor: null });
      }

      const cursor = decodeThreadCursor(q.cursor) ?? undefined;
      const query: ThreadListQuery = {
        labelSlug: q.labelSlug,
        search: q.search,
        from: q.from,
        to: q.to,
        subject: q.subject,
        excludeWords: q.excludeWords,
        hasAttachment: q.hasAttachment,
        pageSize: q.pageSize,
        offset: cursor ? undefined : (q.page - 1) * q.pageSize,
        cursor,
      };
      const result =
        accountIds.length === 1
          ? await store.mailbox(accountIds[0]!).listThreads(query)
          : await store.listThreads(accountIds, query);
      return success(c, {
        threads: result.threads,
        totalCount: result.totalCount,
        nextCursor: result.nextCursor ? encodeThreadCursor(result.nextCursor) : null,
      });
    } catch (err) {
      console.error('[app-api/mail-labels] threads-by-label failed:', err);
      return error.internal(c, 'Failed to fetch threads for label');
    }
  },
);

// ---------------------------------------------------------------------------
// Bulk apply / unapply — also static paths, declared before /:id.
// ---------------------------------------------------------------------------

app.post(
  '/add-to-messages',
  requirePermission('messages:update'),
  zValidator('json', applyToMessagesBody),
  async (c) => {
    const { labelName, messageIds } = c.req.valid('json');
    try {
      const db = c.get('tenantDb');
      const { store, access, mode } = await workspaceMailFromContext(c);
      let accountByMessage: Map<string, string>;
      if (mode === 'postgres' || mode === 'shadow') {
        if (!(await canAccessMessageAccounts(db, access, messageIds))) {
          return error.forbidden(c, 'Access to one or more mail accounts is not allowed');
        }
        accountByMessage = await store.locateMessages(messageIds, await access.accessibleAccountIds());
      } else {
        accountByMessage = await accessibleMessageAccounts(store, access, messageIds);
      }
      const byAccount = new Map<string, string[]>();
      for (const [id, accountId] of accountByMessage) {
        (byAccount.get(accountId) ?? byAccount.set(accountId, []).get(accountId)!).push(id);
      }
      let affected = 0;
      for (const [accountId, ids] of byAccount) {
        const result = await store.mailbox(accountId).apply({ kind: 'labels.add', ids, labels: [labelName], semantics: 'bulk' });
        affected += result.applied.length;
      }
      const anchorId = messageIds[0]!;
      const anchorAccountId = accountByMessage.get(anchorId) ?? '';
      publishEntityEvent({
        c,
        entityType: 'email',
        entityId: anchorId,
        action: 'updated',
        data: { id: anchorId, accountId: anchorAccountId, subject: null, from: null, to: null },
      });
      return success(c, { count: affected });
    } catch (err) {
      console.error('[app-api/mail-labels] add-to-messages failed:', err);
      return error.internal(c, 'Failed to apply label');
    }
  },
);

app.post(
  '/remove-from-messages',
  requirePermission('messages:update'),
  zValidator('json', applyToMessagesBody),
  async (c) => {
    const { labelName, messageIds } = c.req.valid('json');
    try {
      const db = c.get('tenantDb');
      const { store, access, mode } = await workspaceMailFromContext(c);
      let accountByMessage: Map<string, string>;
      if (mode === 'postgres' || mode === 'shadow') {
        if (!(await canAccessMessageAccounts(db, access, messageIds))) {
          return error.forbidden(c, 'Access to one or more mail accounts is not allowed');
        }
        accountByMessage = await store.locateMessages(messageIds, await access.accessibleAccountIds());
      } else {
        accountByMessage = await accessibleMessageAccounts(store, access, messageIds);
      }
      const byAccount = new Map<string, string[]>();
      for (const [id, accountId] of accountByMessage) {
        (byAccount.get(accountId) ?? byAccount.set(accountId, []).get(accountId)!).push(id);
      }
      let affected = 0;
      for (const [accountId, ids] of byAccount) {
        const result = await store.mailbox(accountId).apply({ kind: 'labels.remove', ids, labels: [labelName], semantics: 'bulk' });
        affected += result.applied.length;
      }
      const anchorId = messageIds[0]!;
      const anchorAccountId = accountByMessage.get(anchorId) ?? '';
      publishEntityEvent({
        c,
        entityType: 'email',
        entityId: anchorId,
        action: 'updated',
        data: { id: anchorId, accountId: anchorAccountId, subject: null, from: null, to: null },
      });
      return success(c, { count: affected });
    } catch (err) {
      console.error('[app-api/mail-labels] remove-from-messages failed:', err);
      return error.internal(c, 'Failed to remove label');
    }
  },
);

app.post(
  '/apply-to-thread',
  requirePermission('messages:update'),
  zValidator('json', threadLabelBody),
  async (c) => {
    const { accountId, threadId, labelName, action } = c.req.valid('json');
    try {
      const { store, access } = await workspaceMailFromContext(c);
      const allowed = await access.canOpen(accountId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
      const result = await store.mailbox(accountId).apply({ kind: 'thread.label', threadKey: threadId, label: labelName, action });
      // Thread label changes move messages between folder views — fan out as
      // email:updated so other screens invalidate `['mail']`.
      publishEntityEvent({
        c,
        entityType: 'email',
        entityId: threadId,
        action: 'updated',
        data: { id: threadId, accountId, subject: null, from: null, to: null },
      });
      // `thread.label`'s `updatedIds` is the thread's changed message ids (same
      // shape `thread.read` reports), so `affected` is the per-message count a
      // caller archiving/trashing a thread expects — not a thread-scoped "1".
      return success(c, { affected: (result.updatedIds ?? result.applied).length, action });
    } catch (err) {
      console.error('[app-api/mail-labels] apply-to-thread failed:', err);
      return error.internal(c, 'Failed to update thread labels');
    }
  },
);

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

app.get('/', requirePermission('accounts:read'), zValidator('query', listQuery), async (c) => {
  try {
    const db = c.get('tenantDb');
    const { accountId } = c.req.valid('query');
    const { access } = await workspaceMailFromContext(c);
    if (accountId) {
      if (!(await access.canOpen(accountId))) {
        return error.forbidden(c, 'Access to this mail account is not allowed');
      }
      const rows = await listMailLabels(db, { accountId });
      return success(c, rows);
    }
    // No accountId: unified label list across every mailbox the caller may
    // open, never every mailbox in the workspace (MAIL-003).
    const scopedAccountIds = await access.accessibleAccountIds();
    if (scopedAccountIds.length === 0) return success(c, []);
    const rows = await listMailLabels(db, { accessibleAccountIds: scopedAccountIds });
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/mail-labels] list failed:', err);
    return error.internal(c, 'Failed to list labels');
  }
});

app.get('/:id', requirePermission('accounts:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const row = await getMailLabel(db, id);
    if (!row) return error.notFound(c, 'Label', id);
    const { access } = await workspaceMailFromContext(c);
    const allowed = await access.canOpen(row.accountId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    return success(c, row);
  } catch (err) {
    console.error('[app-api/mail-labels] get failed:', err);
    return error.internal(c, 'Failed to fetch label');
  }
});

app.post(
  '/',
  requirePermission('accounts:create'),
  zValidator('json', createBody),
  async (c) => {
    const data = c.req.valid('json');
    try {
      const db = c.get('tenantDb');
      const { access } = await workspaceMailFromContext(c);
      const allowed = await access.canOpen(data.accountId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
      const row = await createMailLabel(db, data);
      await bumpMailboxDirectory(c.env, c.get('workspaceId'));
      publishEntityEvent({
        c,
        entityType: 'mail_label',
        entityId: row.id,
        action: 'created',
        data: { id: row.id, accountId: row.accountId, name: row.name },
      });
      return success(c, row, 201);
    } catch (err) {
      if (err instanceof MailLabelError) return mapLabelError(c, err);
      console.error('[app-api/mail-labels] create failed:', err);
      return error.internal(c, 'Failed to create label');
    }
  },
);

const applyUpdate = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }>,
  id: string,
  data: z.infer<typeof updateBody>,
) => {
  const db = c.get('tenantDb');
  const { store, access, mode } = await workspaceMailFromContext(c);
  const existing = await getMailLabel(db, id);
  if (!existing) return error.notFound(c, 'Label', id);
  const allowed = await access.canOpen(existing.accountId);
  if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
  try {
    // The row update already relabels every referencing message atomically
    // on Postgres (`updateMailLabel`'s own `atomically(...)` call) — unchanged,
    // so `postgres` keeps its exact behaviour. In every other mode the
    // mailbox store needs to hear about a rename too, so its own copy of the
    // affected messages' labels stays in sync.
    const result = await updateMailLabel(db, id, data);
    await bumpMailboxDirectory(c.env, c.get('workspaceId'));
    if (mode !== 'postgres' && data.name && data.name !== existing.name) {
      try {
        await store.mailbox(existing.accountId).apply({ kind: 'label.rename', from: existing.name, to: data.name });
      } catch (opErr) {
        console.error('[app-api/mail-labels] label.rename mirror failed:', opErr);
      }
    }
    publishEntityEvent({
      c,
      entityType: 'mail_label',
      entityId: id,
      action: 'updated',
      data: { id, accountId: result.after.accountId, name: result.after.name },
    });
    return success(c, result.after);
  } catch (err) {
    if (err instanceof MailLabelError) return mapLabelError(c, err);
    console.error('[app-api/mail-labels] update failed:', err);
    return error.internal(c, 'Failed to update label');
  }
};

app.put(
  '/:id',
  requirePermission('accounts:update'),
  zValidator('json', updateBody),
  async (c) => applyUpdate(c, c.req.param('id'), c.req.valid('json')),
);

app.patch(
  '/:id',
  requirePermission('accounts:update'),
  zValidator('json', updateBody),
  async (c) => applyUpdate(c, c.req.param('id'), c.req.valid('json')),
);

app.delete('/:id', requirePermission('accounts:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const { store, access, mode } = await workspaceMailFromContext(c);
    const existing = await getMailLabel(db, id);
    if (!existing) return error.notFound(c, 'Label', id);
    const allowed = await access.canOpen(existing.accountId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const row = await deleteMailLabel(db, id);
    if (!row) return error.notFound(c, 'Label', id);
    await bumpMailboxDirectory(c.env, c.get('workspaceId'));
    if (mode !== 'postgres') {
      try {
        await store.mailbox(row.accountId).apply({ kind: 'label.delete', name: row.name });
      } catch (opErr) {
        console.error('[app-api/mail-labels] label.delete mirror failed:', opErr);
      }
    }
    publishEntityEvent({
      c,
      entityType: 'mail_label',
      entityId: id,
      action: 'deleted',
      data: { id, accountId: row.accountId, name: row.name },
    });
    return success(c, { id, deleted: true });
  } catch (err) {
    if (err instanceof MailLabelError) return mapLabelError(c, err);
    console.error('[app-api/mail-labels] delete failed:', err);
    return error.internal(c, 'Failed to delete label');
  }
});

export const mailLabelsRoutes = app;
