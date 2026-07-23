/**
 * Mail thread routes — /api/mail-threads/*.
 *
 * Thread-level mutations that span every message sharing a `threadId`
 * (or the message's own `id` when it's the thread head). Read-side
 * thread aggregation lives on `/api/mail-labels/threads`; this surface
 * is the write side.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { markThreadRead } from '../../services/mail/thread-ops';
import { checkAccountAccess } from '../../services/mail/access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const readBody = z.object({ isRead: z.boolean() });

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
    const allowed = await checkAccountAccess(c.get('tenantDb'), accountId, c.get('userId'));
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    try {
      const result = await markThreadRead(
        c.get('tenantDb'),
        accountId,
        threadId,
        c.req.valid('json').isRead,
      );
      return success(c, result);
    } catch (err) {
      console.error('[app-api/mail-threads] mark-read failed:', err);
      return error.internal(c, 'Failed to update thread read state');
    }
  },
);

export const mailThreadsRoutes = app;
