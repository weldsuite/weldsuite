/**
 * WeldSuite mail-api — the WeldMail (mail accounts, domains, drafts, folders,
 * labels, messages, threads, rules, scheduled sends, signatures, snooze,
 * subscriptions, sync, templates, campaigns, WeldMail addresses, mail AI and
 * the mailbox directory) module's API worker, plus the SendScheduledEmail
 * workflow, the snooze wake-up cron, and the outbound guard's Durable Objects
 * and queue consumers (docs/plans/weldmail-outbound-abuse.md).
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { clerkMiddleware } from '@weldsuite/worker-kit/middleware/clerk';
import { isSnoozeSweepCron, runSnoozeSweep } from './cron/snooze-sweep';
import { sendPendingOutboundAlerts } from './cron/outbound-alerts';
import { mailAccountsRoutes } from './routes/mail-accounts';
import { mailAiRoutes } from './routes/mail-ai';
import { mailAttachmentsRoutes } from './routes/mail-attachments';
import { mailCampaignsRoutes } from './routes/mail-campaigns';
import { mailDomainsRoutes } from './routes/mail-domains';
import { mailDraftsRoutes } from './routes/mail-drafts';
import { mailFoldersRoutes } from './routes/mail-folders';
import { mailLabelsRoutes } from './routes/mail-labels';
import { mailMessagesRoutes } from './routes/mail-messages';
import { mailRulesRoutes } from './routes/mail-rules';
import { mailScheduledRoutes } from './routes/mail-scheduled';
import { mailSignaturesRoutes } from './routes/mail-signatures';
import { mailSnoozeRoutes } from './routes/mail-snooze';
import { mailSubscriptionsRoutes } from './routes/mail-subscriptions';
import { mailSyncRoutes } from './routes/mail-sync';
import { mailTemplatesRoutes } from './routes/mail-templates';
import { mailThreadsRoutes } from './routes/mail-threads';
import { mailWeldMailRoutes } from './routes/mail-weldmail';
import { mailboxesRoutes } from './routes/mailboxes';
import { mailSendingRoutes } from './routes/mail-sending';
import { internalOutboundRoutes } from './routes/internal-outbound';
import {
  handleOutboundReviewBatch,
  handleSendingEventsBatch,
  type OutboundReviewMessage,
} from '@weldsuite/mail-domain/outbound/consumers';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'mail-api' });

// Outbound guard staff API (admin console, shared secret; not Clerk). Kept off
// the /api/* auth chain on purpose. docs/plans/weldmail-outbound-abuse.md.
app.route('/internal/outbound', internalOutboundRoutes);

// Mailbox directory — Clerk-authenticated but org-LESS: WeldMail lists every
// workspace mailbox the user can see without flipping the active org (personal
// inboxes stay on personal-api). clerkMiddleware only; must stay ABOVE the
// global /api/* workspaceDb guard.
app.use('/api/mailboxes', clerkMiddleware());
app.route('/api/mailboxes', mailboxesRoutes);

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Object-based routes, in app-api's mount order.
app.route('/api/mail-accounts', mailAccountsRoutes);
app.route('/api/mail-ai', mailAiRoutes);
app.route('/api/mail-attachments', mailAttachmentsRoutes);
app.route('/api/mail-campaigns', mailCampaignsRoutes);
app.route('/api/mail-domains', mailDomainsRoutes);
app.route('/api/mail-drafts', mailDraftsRoutes);
app.route('/api/mail-folders', mailFoldersRoutes);
app.route('/api/mail-labels', mailLabelsRoutes);
app.route('/api/mail-messages', mailMessagesRoutes);
app.route('/api/mail-rules', mailRulesRoutes);
app.route('/api/mail-scheduled', mailScheduledRoutes);
app.route('/api/mail-sending', mailSendingRoutes);
app.route('/api/mail-signatures', mailSignaturesRoutes);
app.route('/api/mail-snooze', mailSnoozeRoutes);
app.route('/api/mail-subscriptions', mailSubscriptionsRoutes);
app.route('/api/mail-sync', mailSyncRoutes);
app.route('/api/mail-templates', mailTemplatesRoutes);
app.route('/api/mail-threads', mailThreadsRoutes);
app.route('/api/mail-weldmail', mailWeldMailRoutes);

// Cloudflare Workflow classes hosted by this worker (bound in wrangler.toml).
// Scheduled mail delivery, under the `send-scheduled-email-v3*` names: app-api
// keeps `send-scheduled-email-v2*` only while its in-flight instances drain.
export { SendScheduledEmailWorkflow } from '@weldsuite/mail-domain/workflows/send-scheduled-email';

// Outbound guard Durable Objects (docs/plans/weldmail-outbound-abuse.md): one
// ledger per workspace, and the platform budget. Every worker that sends mail
// binds them from here by script_name.
export { OutboundLedger, OutboundPlatformBudget } from '@weldsuite/mail-domain/outbound/ledger';

/** Queues this worker consumes, by name prefix (the suffix is the environment). */
const OUTBOUND_REVIEW_QUEUE = 'mail-outbound-review-';
const SENDING_EVENTS_QUEUE = 'mail-sending-events-';

export default {
  fetch: app.fetch,

  queue: async (batch: MessageBatch<unknown>, env: Env) => {
    if (batch.queue.startsWith(OUTBOUND_REVIEW_QUEUE)) {
      await handleOutboundReviewBatch(batch as MessageBatch<OutboundReviewMessage>, env);
    } else if (batch.queue.startsWith(SENDING_EVENTS_QUEUE)) {
      await handleSendingEventsBatch(batch, env);
    } else {
      console.warn('[mail-api] message from an unknown queue:', batch.queue);
      batch.ackAll();
    }
  },

  scheduled: async (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // Bring snoozed mail whose time has come back to the inbox.
    // */5 in production and local dev; hourly on test (see wrangler.toml).
    if (isSnoozeSweepCron(event.cron)) {
      ctx.waitUntil(
        runSnoozeSweep(env).catch((err) => {
          console.error('[SnoozeSweep] Failed:', err);
        }),
      );
      // Outbound guard: email staff about new cases (master DB only).
      ctx.waitUntil(sendPendingOutboundAlerts(env));
    }
  },
};
