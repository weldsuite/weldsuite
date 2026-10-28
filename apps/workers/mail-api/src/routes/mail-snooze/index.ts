/**
 * Mail snooze routes — /api/mail-snooze/*.
 *
 * Per-message snooze state. Snooze metadata is stored on the message's
 * `customFields` blob rather than a separate column so the inbox UI
 * can pick it up from the same row it already queries for the message
 * list. Auto-unsnooze on `until` is handled by the snooze sweep
 * (src/cron/snooze-sweep.ts); snooze and re-snooze mark the workspace due in
 * its D1 index, so the sweep never opens idle tenants to find out.
 *
 * URLs are flat: `accountId` rides in the path so a single
 * `/messages/:messageId` segment is unambiguous within an account.
 *
 * Every snooze/unsnooze/resnooze/list call goes through
 * `workspaceMailFromContext`'s `store`/`access` (design
 * docs/plans/weldmail-mailbox-store-design.md, task D2); the store's
 * `snooze`/`resnooze`/`unsnooze` ops call the exact same
 * `@weldsuite/mail-domain/snooze` functions this route used to call directly
 * in `postgres` mode, so a thrown `MailSnoozeError` (bad "until", not
 * currently snoozed) still surfaces the same way.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { MailSnoozeError } from '@weldsuite/mail-domain/snooze';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { workspaceMailFromContext } from '../../lib/mail-store-context';

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
      const { store, access } = await workspaceMailFromContext(c);
      const { accountId } = c.req.valid('query');
      if (accountId) {
        if (!(await access.canOpen(accountId))) {
          return error.forbidden(c, 'Access to this mail account is not allowed');
        }
        const rows = await store.mailbox(accountId).listSnoozed();
        return success(c, rows);
      }
      // No accountId: unified snoozed list across every mailbox the caller
      // may open, never every mailbox in the workspace (MAIL-003).
      const scopedAccountIds = await access.accessibleAccountIds();
      const rows = await store.listSnoozed(scopedAccountIds);
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
    try {
      const { store, access } = await workspaceMailFromContext(c);
      const allowed = await access.canOpen(accountId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
      const untilDate = new Date(until);
      const result = await store.mailbox(accountId).apply({ kind: 'snooze', id: messageId, until: untilDate.getTime() });
      if (!result.applied.includes(messageId)) {
        return error.notFound(c, 'Message');
      }
      // Tell the snooze sweep when to look at this workspace (D1 due index).
      await markWorkspaceDue(c.env.SCHEDULE_INDEX, 'mail_snooze', c.get('clerkOrgId'), untilDate);
      return success(c, { id: messageId, snoozedUntil: untilDate.toISOString() });
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
    try {
      const { store, access } = await workspaceMailFromContext(c);
      const allowed = await access.canOpen(accountId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
      const result = await store.mailbox(accountId).apply({ kind: 'unsnooze', id: messageId });
      if (!result.applied.includes(messageId)) {
        return error.notFound(c, 'Message');
      }
      return success(c, { id: messageId });
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
    try {
      const { store, access } = await workspaceMailFromContext(c);
      const allowed = await access.canOpen(accountId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
      const untilDate = new Date(until);
      const result = await store.mailbox(accountId).apply({ kind: 'resnooze', id: messageId, until: untilDate.getTime() });
      if (!result.applied.includes(messageId)) {
        return error.notFound(c, 'Message');
      }
      await markWorkspaceDue(c.env.SCHEDULE_INDEX, 'mail_snooze', c.get('clerkOrgId'), untilDate);
      return success(c, { id: messageId, snoozedUntil: untilDate.toISOString() });
    } catch (err) {
      if (err instanceof MailSnoozeError) return mapSnoozeError(c, err);
      console.error('[app-api/mail-snooze] resnooze failed:', err);
      return error.internal(c, 'Failed to resnooze message');
    }
  },
);

export const mailSnoozeRoutes = app;
