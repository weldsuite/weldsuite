/**
 * Mail subscription routes — /api/mail-subscriptions/*.
 *
 * Gmail-style "Manage subscriptions": the mailing lists an account
 * receives (rows upserted by mail-inbound-worker from `List-Unsubscribe`),
 * a backfill scan over stored messages, and one-button unsubscribe.
 *
 * Entity events: `mail_subscription:unsubscribed`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { UnsubscribeError } from '@weldsuite/email/list-unsubscribe';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { checkAccountAccess } from '../../services/mail/access';
import {
  getSubscription,
  listSubscriptions,
  scanSubscriptions,
  unsubscribe,
} from '../../services/mail/subscriptions';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({
  accountId: z.string().min(1),
  status: z.enum(['active', 'unsubscribed']).optional(),
});

const scanBody = z.object({
  accountId: z.string().min(1),
});

app.get(
  '/',
  requirePermission('messages:read'),
  zValidator('query', listQuery),
  async (c) => {
    const db = c.get('tenantDb');
    const { accountId, status } = c.req.valid('query');
    if (!(await checkAccountAccess(db, accountId, c.get('userId')))) {
      return error.notFound(c, 'Mail account', accountId);
    }
    try {
      return success(c, await listSubscriptions(db, { accountId, status }));
    } catch (err) {
      console.error('[app-api/mail-subscriptions] list failed:', err);
      return error.internal(c, 'Failed to list subscriptions');
    }
  },
);

app.post(
  '/scan',
  requirePermission('messages:update'),
  zValidator('json', scanBody),
  async (c) => {
    const db = c.get('tenantDb');
    const { accountId } = c.req.valid('json');
    if (!(await checkAccountAccess(db, accountId, c.get('userId')))) {
      return error.notFound(c, 'Mail account', accountId);
    }
    try {
      return success(c, await scanSubscriptions(db, accountId));
    } catch (err) {
      console.error('[app-api/mail-subscriptions] scan failed:', err);
      return error.internal(c, 'Failed to scan for subscriptions');
    }
  },
);

app.post('/:id/unsubscribe', requirePermission('messages:update'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');

  const subscription = await getSubscription(db, id);
  // Same 404 for missing and inaccessible so private accounts don't leak.
  if (!subscription || !(await checkAccountAccess(db, subscription.accountId, userId))) {
    return error.notFound(c, 'Subscription', id);
  }

  try {
    const result = await unsubscribe(c.env, db, {
      orgId,
      userId,
      subscription,
      waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx),
    });
    publishEntityEvent({
      c,
      entityType: 'mail_subscription',
      action: 'unsubscribed',
      entityId: result.subscription.id,
      data: {
        id: result.subscription.id,
        accountId: result.subscription.accountId,
        senderEmail: result.subscription.senderEmail,
        method: result.outcome.method,
      },
    });
    return success(c, {
      subscription: result.subscription,
      method: result.outcome.method,
      url: result.outcome.url,
    });
  } catch (err) {
    if (err instanceof UnsubscribeError) {
      return err.code === 'NO_UNSUBSCRIBE_METHOD'
        ? error.badRequest(c, err.message)
        : error.badGateway(c, err.message);
    }
    console.error('[app-api/mail-subscriptions] unsubscribe failed:', err);
    return error.internal(c, 'Failed to unsubscribe');
  }
});

export const mailSubscriptionsRoutes = app;
