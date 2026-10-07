/**
 * WeldSuite mail-api — the WeldMail (mail accounts, domains, drafts, folders,
 * labels, messages, threads, rules, scheduled sends, signatures, snooze,
 * subscriptions, sync, templates, campaigns, WeldMail addresses, mail AI and
 * the mailbox directory) module's API worker, plus the SendScheduledEmail
 * workflow and the snooze wake-up cron.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { clerkMiddleware } from '@weldsuite/worker-kit/middleware/clerk';
import { isSnoozeSweepCron, runSnoozeSweep } from './cron/snooze-sweep';
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
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'mail-api' });

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

export default {
  fetch: app.fetch,

  scheduled: async (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // Bring snoozed mail whose time has come back to the inbox.
    // */5 in production and local dev; hourly on test (see wrangler.toml).
    if (isSnoozeSweepCron(event.cron)) {
      ctx.waitUntil(
        runSnoozeSweep(env).catch((err) => {
          console.error('[SnoozeSweep] Failed:', err);
        }),
      );
    }
  },
};
