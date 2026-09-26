/**
 * WeldSuite pass-api — the WeldPass (secret vaults) module's API worker.
 *
 * The first module split out of app-api (docs/plans/app-api-module-split.md,
 * phase 1). It serves the same /api/weldpass paths app-api served; app-api
 * forwards them here over the PASS_API service binding for clients that still
 * call app-api. Workspace-scoped through the kit's Clerk → tenant DB chain, so
 * a vault belongs to a workspace exactly as it did in app-api.
 *
 * No entity events: WeldPass writes its own trail to weldpass_audit_events.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { weldpassRoutes } from './routes/weldpass';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'pass-api' });

app.use('/api/*', ...apiAuth());

app.route('/api/weldpass', weldpassRoutes);

export default {
  fetch: app.fetch,
};
