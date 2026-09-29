/**
 * WeldSuite hr-api — the WeldHR (employees, time, lifecycle, performance,
 * workforce portal) module's API worker.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { publicHrPortalRoutes } from './routes/public-hr-portal';
import { weldhrRoutes } from './routes/weldhr';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'hr-api' });

// Public WeldHR workforce portal consumed by apps/web/hr-portal. Same model as
// the commerce portal: tenant from slug, email-OTP sign-in, hashed KV session.
// Must stay ABOVE the app.use('/api/*', ...) guard below.
app.route('/public/hr-portal', publicHrPortalRoutes);

app.use('/api/*', ...apiAuth());

// WeldHR — employee operations; Clerk + tenant DB from the /api/* guard.
app.route('/api/weldhr', weldhrRoutes);

export default {
  fetch: app.fetch,
};
