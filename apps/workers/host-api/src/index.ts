/**
 * WeldSuite host-api — the WeldHost (domains, DNS, transfers, email forwards)
 * module's API worker.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { dnsRecordsRoutes } from './routes/dns-records';
import { dnsZonesRoutes } from './routes/dns-zones';
import { domainTransfersRoutes } from './routes/domain-transfers';
import { domainsRoutes } from './routes/domains';
import { emailForwardsRoutes } from './routes/email-forwards';
import { realtimeRegisterWebhookRoutes } from './routes/webhooks-realtime-register';
import { runDomainAutoRenewSweep } from './cron/domain-auto-renew';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'host-api' });

// Realtime Register process/notification webhook — PUBLIC. Auth is the shared
// `?token=` (REALTIME_REGISTER_WEBHOOK_SECRET). Advances pending_workflow
// domain rows / transfers via the WORKSPACE_CACHE process mapping.
app.route('/public/webhooks/realtime-register', realtimeRegisterWebhookRoutes);

app.use('/api/*', ...apiAuth());

app.route('/api/dns-records', dnsRecordsRoutes);
app.route('/api/dns-zones', dnsZonesRoutes);
app.route('/api/domain-transfers', domainTransfersRoutes);
app.route('/api/domains', domainsRoutes);
app.route('/api/email-forwards', emailForwardsRoutes);

export default {
  fetch: app.fetch,
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // Daily at 04:00 UTC: invoice+renew WeldHost domains that are inside the
    // auto-renew window.
    if (event.cron === '0 4 * * *') {
      ctx.waitUntil(
        runDomainAutoRenewSweep(env).catch((err) => {
          console.error('[DomainAutoRenew] Failed:', err);
        }),
      );
    }
  },
};
