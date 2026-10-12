/**
 * WeldSuite reach-api — WeldReach, cold email outreach on Mailpool.
 *
 * docs/plans/weldreach.md. HTTP: `/api/reach/*` behind apiAuth + the
 * `weldreach` app-access gate (on request only; staff approve workspaces in the
 * admin console), and `/public/reach/*` for the Mailpool webhook (HMAC).
 * Background: a cron sweep feeds the `reach-send` queue (SMTP sends), an hourly
 * cron tracks warmup (and once a day Mailpool slots), and `email()` receives the replies
 * Mailpool mailboxes forward to REACH_INBOUND_DOMAIN.
 */

import { apiAuth, appAccessGate, createModuleApi } from '@weldsuite/worker-kit';
import { WELDREACH_APP_CODE } from '@weldsuite/app-api-client/schemas/reach';
import type { Env, ReachSendMessage, Variables } from './types';

import accessRoutes from './routes/access';
import settingsRoutes from './routes/settings';
import billingRoutes from './routes/billing';
import domainRoutes from './routes/domains';
import mailboxRoutes from './routes/mailboxes';
import prospectRoutes from './routes/prospects';
import listRoutes from './routes/lists';
import campaignRoutes from './routes/campaigns';
import suppressionRoutes from './routes/suppressions';
import overviewRoutes from './routes/overview';
import inboxRoutes from './routes/inbox';
import publicWebhookRoutes from './routes/public-webhooks';

import { handleScheduled } from './cron';
import { handleSendQueue } from './queue/send-consumer';
import { handleInboundEmail } from './email/handler';

const app = createModuleApi<Env, Variables>({ service: 'reach-api' });

// Public routes, above the auth guard. The Mailpool webhook verifies its HMAC.
app.route('/public/reach/webhooks', publicWebhookRoutes);

app.use('/api/*', ...apiAuth());
// On request only: every /api/reach route needs approved access (403 APP_ACCESS_REQUIRED otherwise).
app.use('/api/reach/*', appAccessGate(WELDREACH_APP_CODE));

app.route('/api/reach/access', accessRoutes);
app.route('/api/reach/settings', settingsRoutes);
app.route('/api/reach/billing', billingRoutes);
app.route('/api/reach/domains', domainRoutes);
app.route('/api/reach/mailboxes', mailboxRoutes);
app.route('/api/reach/prospects', prospectRoutes);
app.route('/api/reach/lists', listRoutes);
app.route('/api/reach/campaigns', campaignRoutes);
app.route('/api/reach/suppressions', suppressionRoutes);
app.route('/api/reach/overview', overviewRoutes);
app.route('/api/reach/inbox', inboxRoutes);

export default {
  fetch: app.fetch,
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => handleScheduled(event, env, ctx),
  queue: (batch: MessageBatch<ReachSendMessage>, env: Env, ctx: ExecutionContext) => handleSendQueue(batch, env, ctx),
  email: (message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) => handleInboundEmail(message, env, ctx),
};

export { app };
