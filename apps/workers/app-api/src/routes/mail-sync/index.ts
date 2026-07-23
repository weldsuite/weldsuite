/**
 * Mail sync routes — /api/mail-sync/*.
 *
 * Triggers and reports on per-account sync state. The actual fetch loop
 * for pull providers (Gmail OAuth, IMAP, Mailcow) runs out-of-band;
 * these endpoints just flip the status column the inbox UI watches.
 *
 * Cloudflare-routed inbound mail is push-driven, so calling sync on a
 * Cloudflare-managed account is a no-op aside from the status flag.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import * as sync from '../../services/mail/sync';
import { MailSyncError } from '../../services/mail/sync';
import { checkAccountAccess } from '../../services/mail/access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const labelOptional = z.object({ label: z.string().optional() });
const updateStatusBody = z.object({
  status: z.enum(['idle', 'syncing', 'error']),
  errorMessage: z.string().optional(),
});

function mapSyncError(c: Parameters<typeof error.badRequest>[0], err: MailSyncError) {
  if (err.code === 'ACCOUNT_NOT_FOUND') return error.notFound(c, 'Mail account');
  return error.internal(c, err.message);
}

app.post(
  '/accounts/:accountId/sync-messages',
  requirePermission('accounts:update'),
  zValidator('query', labelOptional),
  async (c) => {
    const accountId = c.req.param('accountId');
    const db = c.get('tenantDb');
    const allowed = await checkAccountAccess(db, accountId, c.get('userId'));
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const { label } = c.req.valid('query');
    try {
      const result = await sync.beginSync(db, accountId);
      return success(c, { ...result, syncedMessages: 0, label: label ?? 'inbox' });
    } catch (err) {
      if (err instanceof MailSyncError) return mapSyncError(c, err);
      console.error('[app-api/mail-sync] sync-messages failed:', err);
      return error.internal(c, 'Failed to sync messages');
    }
  },
);

app.post(
  '/accounts/:accountId/full-sync',
  requirePermission('accounts:update'),
  async (c) => {
    const accountId = c.req.param('accountId');
    const db = c.get('tenantDb');
    const allowed = await checkAccountAccess(db, accountId, c.get('userId'));
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    try {
      const result = await sync.beginSync(db, accountId);
      return success(c, { ...result, syncedMessages: 0 });
    } catch (err) {
      if (err instanceof MailSyncError) return mapSyncError(c, err);
      console.error('[app-api/mail-sync] full-sync failed:', err);
      return error.internal(c, 'Failed to perform full sync');
    }
  },
);

app.post(
  '/accounts/:accountId/force-resync',
  requirePermission('accounts:update'),
  zValidator('json', labelOptional),
  async (c) => {
    const accountId = c.req.param('accountId');
    const db = c.get('tenantDb');
    const allowed = await checkAccountAccess(db, accountId, c.get('userId'));
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const { label } = c.req.valid('json');
    try {
      const result = await sync.beginSync(db, accountId);
      return success(c, { ...result, syncedMessages: 0, label: label ?? 'inbox' });
    } catch (err) {
      if (err instanceof MailSyncError) return mapSyncError(c, err);
      console.error('[app-api/mail-sync] force-resync failed:', err);
      return error.internal(c, 'Failed to force resync');
    }
  },
);

app.get(
  '/accounts/:accountId/sync-status',
  requirePermission('accounts:read'),
  async (c) => {
    const accountId = c.req.param('accountId');
    const db = c.get('tenantDb');
    const allowed = await checkAccountAccess(db, accountId, c.get('userId'));
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    try {
      const result = await sync.getSyncStatus(db, accountId);
      if (!result) return error.notFound(c, 'Mail account', accountId);
      return success(c, result);
    } catch (err) {
      console.error('[app-api/mail-sync] sync-status failed:', err);
      return error.internal(c, 'Failed to fetch sync status');
    }
  },
);

app.patch(
  '/accounts/:accountId/sync-status',
  requirePermission('accounts:update'),
  zValidator('json', updateStatusBody),
  async (c) => {
    const accountId = c.req.param('accountId');
    const db = c.get('tenantDb');
    const allowed = await checkAccountAccess(db, accountId, c.get('userId'));
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    try {
      const result = await sync.setSyncStatus(db, accountId, c.req.valid('json'));
      return success(c, result);
    } catch (err) {
      if (err instanceof MailSyncError) return mapSyncError(c, err);
      console.error('[app-api/mail-sync] update-sync-status failed:', err);
      return error.internal(c, 'Failed to update sync status');
    }
  },
);

export const mailSyncRoutes = app;
