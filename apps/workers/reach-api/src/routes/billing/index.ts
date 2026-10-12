/**
 * /api/reach/billing: the inbox subscription ($5 per inbox per month), proxied
 * to billing-worker with the caller's Clerk token (lib/billing.ts).
 *
 *   reach_settings:read      GET /        subscription summary
 *   reach_mailboxes:create   POST /setup  Stripe Checkout (setup mode) to add a payment method
 *
 * Inbox quantity changes are not a route: they happen inside mailbox create /
 * delete (services/mailboxes.ts). No entity events: Stripe state is not a
 * WeldSuite entity.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { success } from '@weldsuite/worker-kit/response';
import { reachBillingSetupSchema } from '@weldsuite/app-api-client/schemas/reach';
import type { Env, Variables } from '../../types';
import { createReachBilling } from '../../lib/billing';
import { reachErrorHandler } from '../../services/reach-errors';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.onError(reachErrorHandler);

app.get('/', requirePermission('reach_settings:read'), async (c) => {
  return success(c, await createReachBilling(c).status());
});

app.post('/setup', requirePermission('reach_mailboxes:create'), zValidator('json', reachBillingSetupSchema), async (c) => {
  return success(c, await createReachBilling(c).setup(c.req.valid('json')));
});

export default app;
