/**
 * WeldSuite hr-api — the WeldHR (employees, time, lifecycle, performance,
 * payroll, My HR) module's API worker.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { weldhrRoutes } from './routes/weldhr';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'hr-api' });

app.use('/api/*', ...apiAuth());

// WeldHR — employee operations; Clerk + tenant DB from the /api/* guard.
app.route('/api/weldhr', weldhrRoutes);

export default {
  fetch: app.fetch,
};
