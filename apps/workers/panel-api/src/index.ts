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
import customEventsRoutes from './routes/custom-events';
import computedPropertiesRoutes from './routes/computed-properties';
import pathRulesRoutes from './routes/path-rules';
import annotationsRoutes from './routes/annotations';
import commentsRoutes from './routes/comments';
import metricTreesRoutes from './routes/metric-trees';
import shareLinksRoutes from './routes/share-links';
import publicRoutes from './routes/public';
import alertsRoutes from './routes/alerts';
import subscriptionsRoutes from './routes/subscriptions';
import exportsRoutes from './routes/exports';
import domainsRoutes from './routes/domains';
import metricTreeValuesRoutes from './routes/metric-tree-values';
import groupsRoutes from './routes/groups';
import groupTypesRoutes from './routes/group-types';
import { scheduled } from './scheduled';

const app = createModuleApi<Env, Variables>({ service: 'panel-api' });

// Public share links (no session; the token is the credential): before apiAuth.
app.route('/public/panel', publicRoutes);

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
app.route('/api/panel/custom-events', customEventsRoutes);
app.route('/api/panel/computed-properties', computedPropertiesRoutes);
app.route('/api/panel/path-rules', pathRulesRoutes);
app.route('/api/panel/annotations', annotationsRoutes);
app.route('/api/panel/comments', commentsRoutes);
app.route('/api/panel/metric-trees', metricTreesRoutes);
app.route('/api/panel/share-links', shareLinksRoutes);
app.route('/api/panel/alerts', alertsRoutes);
app.route('/api/panel/subscriptions', subscriptionsRoutes);
app.route('/api/panel/exports', exportsRoutes);
app.route('/api/panel/metric-tree-values', metricTreeValuesRoutes);
app.route('/api/panel/groups', groupsRoutes);
app.route('/api/panel/group-types', groupTypesRoutes);
// Custom collector domains sit under their project like keys; the (Rust-mirrored) projects router does not serve /:id/domains.
app.route('/api/panel/projects/:id/domains', domainsRoutes);

// Service-binding entrypoint (usage settlement from panel-ingest); see ./internal.ts.
export { PanelApiInternal } from './internal';

export default {
  fetch: app.fetch,
  // Every 10 minutes: due alerts, scheduled reports and exports, pending custom domains (./scheduled.ts).
  scheduled,
};
