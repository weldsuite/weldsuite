/**
 * WeldSuite know-api — the WeldKnow (knowledge spaces and pages) module's API worker.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { knowledgeRoutes } from './routes/knowledge';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'know-api' });

// Public routes (webhooks, portals) mount here, above the auth guard.

app.use('/api/*', ...apiAuth());

app.route('/api/knowledge', knowledgeRoutes);

export default {
  fetch: app.fetch,
};
