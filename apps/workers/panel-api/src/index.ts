/**
 * WeldSuite panel-api — WeldPanel's API worker (product analytics and session
 * recordings, weldsuite-documentation/plans/weldpanel.md).
 *
 * Members work on projects, reports, recordings and people under /api/panel
 * (Clerk, `apiAuth()`). Tracked sites never call this worker: the SDK sends to
 * the public collector apps/workers/panel-ingest. The prefixes it owns are
 * listed in @weldsuite/api-modules and checked by its ownership test.
 *
 * Projects (create, settings, token rotation, install check, secret keys),
 * reports, dashboards, cohorts and the lexicon, people, recordings, heatmaps,
 * live visitors, AI summaries and usage.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { Env, Variables } from './types';
import projectsRoutes from './routes/projects';
import queryRoutes from './routes/query';
import reportsRoutes from './routes/reports';
import dashboardsRoutes from './routes/dashboards';
import cohortsRoutes from './routes/cohorts';
import lexiconRoutes from './routes/lexicon';
import peopleRoutes from './routes/people';
import sessionsRoutes from './routes/sessions';
import insightsRoutes from './routes/insights';
import heatmapsRoutes from './routes/heatmaps';
import liveRoutes from './routes/live';
import keysRoutes from './routes/keys';
import usageRoutes from './routes/usage';

const app = createModuleApi<Env, Variables>({ service: 'panel-api' });

app.use('/api/*', ...apiAuth());

// Authenticated routes: one app.route() per object prefix this module owns
// (packages/core/api-modules lists them).
app.route('/api/panel/projects', projectsRoutes);
app.route('/api/panel/query', queryRoutes);
app.route('/api/panel/reports', reportsRoutes);
app.route('/api/panel/dashboards', dashboardsRoutes);
app.route('/api/panel/cohorts', cohortsRoutes);
app.route('/api/panel/lexicon', lexiconRoutes);
app.route('/api/panel/people', peopleRoutes);
app.route('/api/panel/sessions', sessionsRoutes);
app.route('/api/panel/insights', insightsRoutes);
app.route('/api/panel/heatmaps', heatmapsRoutes);
app.route('/api/panel/live', liveRoutes);
// Secret keys sit under their project; the projects router does not serve /:id/keys, so this one does.
app.route('/api/panel/projects/:id/keys', keysRoutes);
app.route('/api/panel/usage', usageRoutes);

// Service-binding entrypoint (usage settlement from panel-ingest); see ./internal.ts.
export { PanelApiInternal } from './internal';

export default {
  fetch: app.fetch,
};
