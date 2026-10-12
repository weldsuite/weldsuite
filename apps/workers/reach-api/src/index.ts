/**
 * WeldSuite reach-api — the reach module's API worker.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'reach-api' });

// Public routes (webhooks, portals) mount here, above the auth guard.

app.use('/api/*', ...apiAuth());

// Authenticated routes: one app.route() per object prefix this module owns
// (packages/core/api-modules lists them).

export default {
  fetch: app.fetch,
};
