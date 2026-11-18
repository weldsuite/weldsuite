/**
 * WeldSuite forms-api — WeldForms' API worker (forms and surveys).
 *
 * Members build and publish forms under /api/forms (Clerk, `apiAuth()`).
 * Respondents never call this worker: apps/web/forms-portal reads and writes
 * through the public mount /public/forms/*, proving itself with
 * FORMS_PORTAL_SECRET (ADR FORMS-002). The prefixes this worker owns are listed
 * in @weldsuite/api-modules and checked by its ownership test.
 *
 * Every completed response starts ProcessResponseWorkflow (integrations,
 * notifications, receipt); FormCounters is the per-form counter store (views,
 * rate limits, wrong-code counts). The 15-minute cron runs the invitation
 * reminder and digest sweeps (src/cron/sweeps.ts).
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { Env, Variables } from './types';
import aiRoutes from './routes/ai';
import foldersRoutes from './routes/folders';
import crossRoutes from './routes/cross';
import fillRoutes from './routes/fill';
import formsRoutes from './routes/forms';
import integrationsRoutes from './routes/integrations';
import invitationsRoutes from './routes/invitations';
import mediaRoutes from './routes/media';
import publicRoutes from './routes/public';
import responsesRoutes from './routes/responses';
import settingsRoutes from './routes/settings';
import themesRoutes from './routes/themes';
import { isFormsSweepCron, runFormsSweeps } from './cron/sweeps';

export { ProcessResponseWorkflow } from './workflows/process-response';
export { FormCounters } from './durable-objects/form-counters';

const app = createModuleApi<Env, Variables>({ service: 'forms-api' });

// Public (no Clerk session): the respondent side, trusted by the portal's key.
app.route('/public/forms', publicRoutes);

app.use('/api/*', ...apiAuth());

// Authenticated routes: one app.route() per object prefix this module owns
// (packages/core/api-modules lists them).
app.route('/api/forms/forms', formsRoutes);
app.route('/api/forms/forms', responsesRoutes);
app.route('/api/forms/forms', integrationsRoutes);
app.route('/api/forms/forms', invitationsRoutes);
app.route('/api/forms/folders', foldersRoutes);
app.route('/api/forms/themes', themesRoutes);
app.route('/api/forms/media', mediaRoutes);
app.route('/api/forms/fill', fillRoutes);
app.route('/api/forms', settingsRoutes);
app.route('/api/forms', crossRoutes);
app.route('/api/forms', aiRoutes);

export default {
  fetch: app.fetch,

  // Invitation reminders and the daily digest (due index `forms_reminders` / `forms_digest`, src/cron/sweeps.ts).
  scheduled: async (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    if (isFormsSweepCron(event.cron)) {
      ctx.waitUntil(
        runFormsSweeps(env).catch((err) => {
          console.error('[FormsSweeps] Failed:', err);
        }),
      );
    }
  },
};
