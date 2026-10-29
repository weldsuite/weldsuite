/**
 * Mail thread routes — /api/mail-threads/*.
 *
 * Thread-level mutations that span every message sharing a `threadId`
 * (or the message's own `id` when it's the thread head). Read-side
 * thread aggregation lives on `/api/mail-labels/threads`; this surface
 * is the write side.
 *
 * Both routes go through `workspaceMailFromContext`'s `store`/`access`
 * (design docs/plans/weldmail-mailbox-store-design.md, task D2), so marking a
 * folder or a thread read works the same in every mailbox-store mode.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { workspaceMailFromContext } from '../../lib/mail-store-context';
import { queueMailReadPush } from '../../lib/read-push';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const readBody = z.object({ isRead: z.boolean() });

const readAllBody = z.object({
  labelSlug: z.string().min(1).max(100),
  /** One mailbox; omitted for the unified folder over every readable mailbox. */
  accountId: z.string().min(1).optional(),
});

/**
 * Message ids per mailbox the "email read" push carries after a mark-all.
 * Banners only exist for recent mail, so the newest ones are enough, and the
 * badge count travels with every push anyway. Without a cap a mailbox with
 * thousands of unread mails would send a push per 40 of them, per device.
 */
const READ_ALL_PUSH_IDS = 200;

/**
 * POST /read-all — mark every thread in a folder read: one mailbox's
 * (`accountId`) or the unified folder's. Static path, so it never meets
 * `/:threadId/read`.
 */
app.post(
  '/read-all',
  requirePermission('messages:update'),
  zValidator('json', readAllBody),
  async (c) => {
    const { labelSlug, accountId } = c.req.valid('json');
    try {
      const { store, access } = await workspaceMailFromContext(c);
      let accountIds: string[];
      if (accountId) {
        if (!(await access.canOpen(accountId))) {
          return error.forbidden(c, 'Access to this mail account is not allowed');
        }
        accountIds = [accountId];
      } else {
        accountIds = await access.accessibleAccountIds();
      }

      const result = await store.markFolderRead(accountIds, { labelSlug }, { updatedPerAccount: READ_ALL_PUSH_IDS });
      const anchor = result.updated[0];
      if (anchor) {
        // One hub event, like the bulk route: the platform invalidates the
        // whole mail cache on any email event.
        publishEntityEvent({
          c,
          entityType: 'email',
          entityId: anchor.id,
          action: 'updated',
          data: { id: anchor.id, accountId: anchor.accountId, subject: null, from: null, to: null },
        });
      }
      const idsByAccount = new Map<string, string[]>();
      for (const { id, accountId: accId } of result.updated) {
        const ids = idsByAccount.get(accId) ?? [];
        if (ids.length < READ_ALL_PUSH_IDS) ids.push(id);
        idsByAccount.set(accId, ids);
      }
      for (const [accId, ids] of idsByAccount) queueMailReadPush(c, accId, ids);
      return success(c, { updatedCount: result.updatedCount });
    } catch (err) {
      console.error('[app-api/mail-threads] mark-all-read failed:', err);
      return error.internal(c, 'Failed to mark the folder as read');
    }
  },
);

/**
 * POST /:threadId/read — bulk-flip `isRead` for every message in a
 * thread. Body controls direction (true = mark read, false = mark
 * unread). The accountId comes from the query string since one
 * `threadId` value is only unique within an account.
 */
app.post(
  '/:threadId/read',
  requirePermission('messages:update'),
  zValidator('json', readBody),
  async (c) => {
    const threadId = c.req.param('threadId');
    const accountId = c.req.query('accountId');
    if (!accountId) return error.badRequest(c, 'accountId query parameter is required');
    try {
      const { store, access } = await workspaceMailFromContext(c);
      const allowed = await access.canOpen(accountId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
      const isRead = c.req.valid('json').isRead;
      const result = await store.mailbox(accountId).apply({ kind: 'thread.read', threadKey: threadId, isRead });
      const updatedIds = result.updatedIds ?? [];
      if (updatedIds.length > 0) {
        publishEntityEvent({
          c,
          entityType: 'email',
          entityId: threadId,
          action: 'updated',
          data: { id: threadId, accountId, subject: null, from: null, to: null },
        });
      }
      if (isRead) queueMailReadPush(c, accountId, updatedIds);
      return success(c, { updatedCount: updatedIds.length });
    } catch (err) {
      console.error('[app-api/mail-threads] mark-read failed:', err);
      return error.internal(c, 'Failed to update thread read state');
    }
  },
);

export const mailThreadsRoutes = app;
