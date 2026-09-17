/**
 * Personal mail subscriptions — list, backfill scan, one-button unsubscribe.
 * Mirrors app-api's `/api/mail-subscriptions`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { UnsubscribeError } from '@weldsuite/email/list-unsubscribe';
import { getPersonalDb } from '../db';
import { error, success } from '../lib/response';
import { PersonalMailSendError, requireAccount } from '../services/mail-send';
import {
  getSubscription,
  listSubscriptions,
  scanSubscriptions,
  unsubscribe,
} from '../services/mail-subscriptions';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({
  accountId: z.string().min(1),
  status: z.enum(['active', 'unsubscribed']).optional(),
});

const scanBody = z.object({
  accountId: z.string().min(1),
});

app.get('/', zValidator('query', listQuery), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);
  const { accountId, status } = c.req.valid('query');

  try {
    const db = getPersonalDb(c.env);
    await requireAccount(db, personalAccountId, accountId);
    return success(c, await listSubscriptions(db, { personalAccountId, accountId, status }));
  } catch (err) {
    if (err instanceof PersonalMailSendError) return error.notFound(c, 'Mail account', accountId);
    console.error('[personal-api/mail-subscriptions] list failed:', err);
    return error.internal(c, 'Failed to list subscriptions');
  }
});

app.post('/scan', zValidator('json', scanBody), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);
  const { accountId } = c.req.valid('json');

  try {
    const db = getPersonalDb(c.env);
    await requireAccount(db, personalAccountId, accountId);
    return success(c, await scanSubscriptions(db, personalAccountId, accountId));
  } catch (err) {
    if (err instanceof PersonalMailSendError) return error.notFound(c, 'Mail account', accountId);
    console.error('[personal-api/mail-subscriptions] scan failed:', err);
    return error.internal(c, 'Failed to scan for subscriptions');
  }
});

app.post('/:id/unsubscribe', async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);
  const id = c.req.param('id');

  try {
    const db = getPersonalDb(c.env);
    const subscription = await getSubscription(db, personalAccountId, id);
    if (!subscription) return error.notFound(c, 'Subscription', id);

    const result = await unsubscribe(c.env, db, {
      personalAccountId,
      entitlements: c.get('entitlements'),
      subscription,
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
        : error.unavailable(c, err.message);
    }
    console.error('[personal-api/mail-subscriptions] unsubscribe failed:', err);
    return error.internal(c, 'Failed to unsubscribe');
  }
});

export const mailSubscriptionsRoutes = app;
