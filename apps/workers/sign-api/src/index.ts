/**
 * WeldSuite sign-api — WeldSign's API worker (electronic signatures).
 *
 * Members work on requests under /api/sign (Clerk, `apiAuth()`). Signers never
 * call this worker: apps/web/sign-portal runs the signer side itself on the
 * same domain code (@weldsuite/sign-domain/portal, ADR FE-016) and starts this
 * worker's FinalizeEnvelopeWorkflow through a binding. The prefixes it owns
 * are listed in @weldsuite/api-modules and checked by its ownership test.
 *
 * A cron runs the lifecycle sweep (reminders, expiry): src/cron/lifecycle-sweep.ts.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { Env, Variables } from './types';
import envelopesRoutes from './routes/envelopes';
import templatesRoutes from './routes/templates';
import { isLifecycleSweepCron, runLifecycleSweep } from './cron/lifecycle-sweep';

export { FinalizeEnvelopeWorkflow } from './workflows/finalize-envelope';
export { SignCodeAttempts } from '@weldsuite/sign-domain/code-attempts';

const app = createModuleApi<Env, Variables>({ service: 'sign-api' });

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
