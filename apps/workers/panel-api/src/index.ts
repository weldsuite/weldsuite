/**
 * WeldSuite panel-api — WeldPanel's API worker (product analytics and session
 * recordings, docs/plans/weldpanel.md).
 *
 * Members work on projects, reports, recordings and people under /api/panel
 * (Clerk, `apiAuth()`). Tracked sites never call this worker: the SDK sends to
 * the public collector apps/workers/panel-ingest. The prefixes it owns are
 * listed in @weldsuite/api-modules and checked by its ownership test.
 *
 * Phase 0: no routes yet. Projects and keys arrive in phase 1.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'panel-api' });

app.use('/api/*', ...apiAuth());

// Authenticated routes: one app.route() per object prefix this module owns
// (packages/core/api-modules lists them).

export default {
  fetch: app.fetch,
};
