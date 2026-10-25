/**
 * WeldSuite sign-api — WeldSign's API worker (electronic signatures).
 *
 * Members work on requests under /api/sign (Clerk, `apiAuth()`); signers use
 * /public/sign-portal through apps/web/sign-portal, with a signing link and
 * then a signer session (ADR SIGN-002). The prefixes it owns are listed in
 * @weldsuite/api-modules and checked by its ownership test.
 *
 * A cron runs the lifecycle sweep (reminders, expiry): src/cron/lifecycle-sweep.ts.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { Env, Variables } from './types';
import envelopesRoutes from './routes/envelopes';
import templatesRoutes from './routes/templates';
import signPortalRoutes from './routes/public-sign-portal';
import { isLifecycleSweepCron, runLifecycleSweep } from './cron/lifecycle-sweep';

export { FinalizeEnvelopeWorkflow } from './workflows/finalize-envelope';
export { SignCodeAttempts } from './durable-objects/code-attempts';

const app = createModuleApi<Env, Variables>({ service: 'sign-api' });

// The signer portal mounts above the auth guard: signers have no Clerk session.
app.route('/public/sign-portal', signPortalRoutes);

app.use('/api/*', ...apiAuth());

app.route('/api/sign/envelopes', envelopesRoutes);
app.route('/api/sign/templates', templatesRoutes);

export default {
  fetch: app.fetch,

  scheduled: async (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // Reminders that are due, and requests past their expiry (see wrangler.toml).
    if (isLifecycleSweepCron(event.cron)) {
      ctx.waitUntil(
        runLifecycleSweep(env).catch((err) => {
          console.error('[SignLifecycle] Failed:', err);
        }),
      );
    }
  },
};
