/**
 * Mail snooze routes — /api/mail-snooze/*.
 *
 * Per-message snooze state. Snooze metadata is stored on the message's
 * `customFields` blob rather than a separate column so the inbox UI
 * can pick it up from the same row it already queries for the message
 * list. Auto-unsnooze on `until` is handled by a separate sweep — this
 * surface only writes the snooze state.
 *
 * URLs are flat: `accountId` rides in the path so a single
 * `/messages/:messageId` segment is unambiguous within an account.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import * as snooze from '../../services/mail/snooze';
import { MailSnoozeError } from '../../services/mail/snooze';
import { checkAccountAccess } from '../../services/mail/access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const snoozeBody = z.object({ until: z.string().datetime() });
const snoozedListQuery = z.object({ accountId: z.string().optional() });

function mapSnoozeError(c: Parameters<typeof error.badRequest>[0], err: MailSnoozeError) {
  switch (err.code) {
    case 'MESSAGE_NOT_FOUND':
      return error.notFound(c, 'Message');
    case 'NOT_SNOOZED':
    case 'SNOOZE_IN_PAST':
      return error.badRequest(c, err.message);
  }
}

// Static path declared first so it doesn't conflict with /:accountId/...
app.get(
  '/snoozed',
  requirePermission('messages:read'),
  zValidator('query', snoozedListQuery),
  async (c) => {
    try {
      const db = c.get('tenantDb');
      const userId = c.get('userId');
      const { accountId } = c.req.valid('query');
      if (accountId) {
        const allowed = await checkAccountAccess(db, accountId, userId);
        if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
      }
      const rows = await snooze.listSnoozedMessages(db, { accountId });
      return success(c, rows);
    } catch (err) {
      console.error('[app-api/mail-snooze] list failed:', err);
      return error.internal(c, 'Failed to list snoozed messages');
    }
  },
);

app.post(
  '/accounts/:accountId/messages/:messageId/snooze',
  requirePermission('messages:update'),
  zValidator('json', snoozeBody),
  async (c) => {
    const { accountId, messageId } = c.req.param();
    const { until } = c.req.valid('json');
    const db = c.get('tenantDb');
    const allowed = await checkAccountAccess(db, accountId, c.get('userId'));
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    try {
      const result = await snooze.snoozeMessage(
        db,
        accountId,
        messageId,
        new Date(until),
      );
      return success(c, result);
    } catch (err) {
      if (err instanceof MailSnoozeError) return mapSnoozeError(c, err);
      console.error('[app-api/mail-snooze] snooze failed:', err);
      return error.internal(c, 'Failed to snooze message');
    }
  },
);

app.post(
  '/accounts/:accountId/messages/:messageId/unsnooze',
  requirePermission('messages:update'),
  async (c) => {
    const { accountId, messageId } = c.req.param();
    const db = c.get('tenantDb');
    const allowed = await checkAccountAccess(db, accountId, c.get('userId'));
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    try {
      const result = await snooze.unsnoozeMessage(db, accountId, messageId);
      return success(c, result);
    } catch (err) {
      if (err instanceof MailSnoozeError) return mapSnoozeError(c, err);
      console.error('[app-api/mail-snooze] unsnooze failed:', err);
      return error.internal(c, 'Failed to unsnooze message');
    }
  },
);

app.post(
  '/accounts/:accountId/messages/:messageId/resnooze',
  requirePermission('messages:update'),
  zValidator('json', snoozeBody),
  async (c) => {
    const { accountId, messageId } = c.req.param();
    const { until } = c.req.valid('json');
    const db = c.get('tenantDb');
    const allowed = await checkAccountAccess(db, accountId, c.get('userId'));
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    try {
      const result = await snooze.resnoozeMessage(
        db,
        accountId,
        messageId,
        new Date(until),
      );
      return success(c, result);
    } catch (err) {
      if (err instanceof MailSnoozeError) return mapSnoozeError(c, err);
      console.error('[app-api/mail-snooze] resnooze failed:', err);
      return error.internal(c, 'Failed to resnooze message');
    }
  },
);

export const mailSnoozeRoutes = app;
