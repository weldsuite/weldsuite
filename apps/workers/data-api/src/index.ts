/**
 * WeldSuite data-api — the WeldData (lead database, lists, enrichment columns
 * and runs, enrich fields) module's API worker.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { enrichFieldsRoutes } from './routes/enrich-fields';
import { enrichmentsRoutes } from './routes/enrichments';
import { welddataRoutes } from './routes/welddata';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'data-api' });

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Object-based routes, in app-api's mount order.
app.route('/api/enrichments', enrichmentsRoutes);
app.route('/api/enrich-fields', enrichFieldsRoutes);
app.route('/api/welddata', welddataRoutes);

// Cloudflare Workflow classes hosted by this worker (bound in wrangler.toml).
// WeldData enrichment runs, under the `welddata-enrich-v2*` names: app-api
// keeps `welddata-enrich*` only while its in-flight instances drain.
export { WelddataEnrichWorkflow } from '@weldsuite/data-domain/workflows/welddata-enrich';

export default {
  fetch: app.fetch,
};
