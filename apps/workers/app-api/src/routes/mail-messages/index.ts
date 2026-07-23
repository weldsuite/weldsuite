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
 * Entity events: `email:created | updated | deleted | reply_sent`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import * as messages from '../../services/mail/messages';
import { forwardAndPersist, MailSendError, replyAndPersist } from '../../services/mail/send';
import {
  checkAccountAccess,
  hasAccessToAccount,
  isAdminOrOwner,
  userAccessCondition,
} from '../../services/mail/access';
import { eq, and, isNull } from 'drizzle-orm';
import { schema } from '../../db';

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

const labelsBody = z.object({
  labels: z.array(z.string()).min(1),
});

const replyBody = z.object({
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  replyAll: z.boolean().default(false),
});

const forwardBody = z.object({
  to: z.array(z.string().email()).min(1),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  attachments: z.array(forwardAttachmentSchema).optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/', requirePermission('messages:read'), zValidator('query', listQuery), async (c) => {
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const filters = c.req.valid('query');

    // Enforce per-account access. When the caller supplies a specific
    // accountId, verify access to that account. Otherwise restrict the
    // query to accounts the caller can read.
    if (filters.accountId) {
      const allowed = await checkAccountAccess(db, filters.accountId, userId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
      const result = await messages.listMessages(db, filters);
      return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
    }

    const admin = await isAdminOrOwner(db, userId);
    let accessibleAccountIds: string[] | undefined;
    if (!admin) {
      const accountRows = await db
        .select({ id: schema.mailAccounts.id })
        .from(schema.mailAccounts)
        .where(and(isNull(schema.mailAccounts.deletedAt), userAccessCondition(userId)));
      accessibleAccountIds = accountRows.map((r) => r.id);
      if (accessibleAccountIds.length === 0) {
        return list(c, [], cursorPagination(0, false, null));
      }
    }

    const result = await messages.listMessages(db, { ...filters, accessibleAccountIds });
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/mail-messages] list failed:', err);
    return error.internal(c, 'Failed to list mail messages');
  }
});

app.get('/stats', requirePermission('messages:read'), async (c) => {
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const accountId = c.req.query('accountId');
    if (accountId) {
      const allowed = await checkAccountAccess(db, accountId, userId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    }
    const stats = await messages.getMessageStats(db, accountId);
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
    const userId = c.get('userId');
    const accountId = await messages.getMessageAccountId(db, id);
    if (!accountId) return error.notFound(c, 'Message', id);
    const allowed = await checkAccountAccess(db, accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const row = await messages.getMessage(db, id);
    if (!row) return error.notFound(c, 'Message', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/mail-messages] get failed:', err);
    return error.internal(c, 'Failed to fetch message');
  }
});

app.get('/:id/thread', requirePermission('messages:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const accountId = await messages.getMessageAccountId(db, id);
    if (!accountId) return error.notFound(c, 'Thread for message', id);
    const allowed = await checkAccountAccess(db, accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const thread = await messages.getThread(db, id);
    if (!thread) return error.notFound(c, 'Thread for message', id);
    return success(c, thread);
  } catch (err) {
    console.error('[app-api/mail-messages] thread failed:', err);
    return error.internal(c, 'Failed to fetch thread');
  }
});

const patchHandler = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }>,
  id: string,
  data: z.infer<typeof updateBody>,
) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const accountId = await messages.getMessageAccountId(db, id);
  if (!accountId) return error.notFound(c, 'Message', id);
  const allowed = await checkAccountAccess(db, accountId, userId);
  if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
  const after = await messages.updateMessage(db, id, data);
  if (!after) return error.notFound(c, 'Message', id);
  publishEntityEvent({
    c,
    entityType: 'email',
    entityId: id,
    action: 'updated',
    data: {
      id,
      accountId: after.accountId,
      subject: after.subject ?? null,
      from: (after.from as { email?: string } | null)?.email ?? null,
      to: (after.to as { email?: string }[] | null)?.map((t) => t.email ?? '').filter(Boolean) ?? null,
    },
  });
  return success(c, { id, ...data });
};

// PUT and PATCH share an identical body — keeping both verbs registered
// preserves wire compatibility with the legacy api-worker surface.
const updateRoute = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }>,
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

app.post(
  '/bulk',
  requirePermission('messages:update'),
  zValidator('json', bulkBody),
  async (c) => {
    const data = c.req.valid('json');
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    try {
      // Resolve the account for each message and verify access. Fetching
      // all account IDs in a single query keeps the N+1 at O(1) queries.
      const admin = await isAdminOrOwner(db, userId);
      if (!admin) {
        const rows = await db
          .select({ id: schema.mailMessages.id, accountId: schema.mailMessages.accountId })
          .from(schema.mailMessages)
          .where(and(
            isNull(schema.mailMessages.deletedAt),
          ));
        // Build a map of messageId -> accountId for the requested IDs.
        const msgMap = new Map(rows.map((r) => [r.id, r.accountId]));
        const accountRows = await db
          .select({ id: schema.mailAccounts.id, isShared: schema.mailAccounts.isShared, assignedUserIds: schema.mailAccounts.assignedUserIds })
          .from(schema.mailAccounts)
          .where(isNull(schema.mailAccounts.deletedAt));
        const accountMap = new Map(accountRows.map((a) => [a.id, a]));
        for (const msgId of data.messageIds) {
          const accId = msgMap.get(msgId);
          if (!accId) continue; // message doesn't exist — service will ignore it
          const account = accountMap.get(accId);
          if (!account || !hasAccessToAccount(account, userId, false)) {
            return error.forbidden(c, 'Access to one or more mail accounts is not allowed');
          }
        }
      }
      const result = await messages.bulkUpdateMessages(db, data.messageIds, data.action);
      return success(c, result);
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
    const userId = c.get('userId');
    const accountId = await messages.getMessageAccountId(db, id);
    if (!accountId) return error.notFound(c, 'Message', id);
    const allowed = await checkAccountAccess(db, accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const deleted = await messages.softDeleteMessage(db, id);
    if (!deleted) return error.notFound(c, 'Message', id);
    publishEntityEvent({
      c,
      entityType: 'email',
      entityId: id,
      action: 'deleted',
      data: {
        id,
        accountId: deleted.accountId,
        subject: deleted.subject,
        from: null,
        to: null,
      },
    });
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
      const userId = c.get('userId');
      const accountId = await messages.getMessageAccountId(db, id);
      if (!accountId) return error.notFound(c, 'Message', id);
      const allowed = await checkAccountAccess(db, accountId, userId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
      const next = await messages.addMessageLabels(db, id, c.req.valid('json').labels);
      if (next === null) return error.notFound(c, 'Message', id);
      return success(c, { id, labels: next });
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
      const userId = c.get('userId');
      const accountId = await messages.getMessageAccountId(db, id);
      if (!accountId) return error.notFound(c, 'Message', id);
      const allowed = await checkAccountAccess(db, accountId, userId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
      const next = await messages.removeMessageLabels(db, id, c.req.valid('json').labels);
      if (next === null) return error.notFound(c, 'Message', id);
      return success(c, { id, labels: next });
    } catch (err) {
      console.error('[app-api/mail-messages] remove-labels failed:', err);
      return error.internal(c, 'Failed to remove labels');
    }
  },
);

/**
 * POST /:id/reply — send a reply to a message. Routed through the
 * Cloudflare `send_email` binding via the shared send helper.
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
      const result = await replyAndPersist(
        c.env,
        db,
        orgId,
        userId,
        id,
        data,
        c.executionCtx.waitUntil.bind(c.executionCtx),
      );
      publishEntityEvent({
        c,
        entityType: 'email',
        entityId: result.messageId,
        action: 'reply_sent',
        data: {
          id: result.messageId,
          accountId: result.accountId,
          subject: result.subject,
          from: null,
          to: null,
          conversationId: result.repliedTo,
        },
      });
      return success(c, {
        messageId: result.messageId,
        smtpMessageId: result.smtpMessageId,
        pendingVerification: result.pendingVerification,
        repliedTo: result.repliedTo,
      });
    } catch (err) {
      if (err instanceof MailSendError) {
        switch (err.code) {
          case 'ACCOUNT_NOT_FOUND':
            return error.notFound(c, 'Message', id);
          case 'INVALID_RECIPIENTS':
            return error.badRequest(c, err.message, err.details);
          case 'SEND_BINDING_MISSING':
          case 'STORAGE_BINDING_MISSING':
            return c.json({ error: { code: err.code, message: err.message } }, 503);
          default:
            return error.internal(c, err.message);
        }
      }
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
      const result = await forwardAndPersist(
        c.env,
        db,
        orgId,
        userId,
        id,
        data,
        c.executionCtx.waitUntil.bind(c.executionCtx),
      );
      publishEntityEvent({
        c,
        entityType: 'email',
        entityId: result.messageId,
        action: 'email_sent',
        data: {
          id: result.messageId,
          accountId: result.accountId,
          subject: result.subject,
          from: null,
          to: data.to,
          conversationId: result.forwardedFrom,
        },
      });
      return success(c, {
        messageId: result.messageId,
        smtpMessageId: result.smtpMessageId,
        pendingVerification: result.pendingVerification,
        forwardedFrom: result.forwardedFrom,
      });
    } catch (err) {
      if (err instanceof MailSendError) {
        switch (err.code) {
          case 'ACCOUNT_NOT_FOUND':
            return error.notFound(c, 'Message', id);
          case 'INVALID_RECIPIENTS':
            return error.badRequest(c, err.message, err.details);
          case 'SEND_BINDING_MISSING':
          case 'STORAGE_BINDING_MISSING':
            return c.json({ error: { code: err.code, message: err.message } }, 503);
          default:
            return error.internal(c, err.message);
        }
      }
      console.error('[app-api/mail-messages] forward failed:', err);
      return error.internal(c, 'Failed to forward email');
    }
  },
);

export const mailMessagesRoutes = app;
