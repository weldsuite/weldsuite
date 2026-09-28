/**
 * WeldSuite crm-api — the WeldCRM (companies, people, person-companies, leads,
 * opportunities, pipelines, pipeline stages and field visibility, activities,
 * customer statuses, lists, CRM analytics, sequences and customer sequences)
 * module's API worker.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { activitiesRoutes } from './routes/activities';
import { companiesRoutes } from './routes/companies';
import { crmAnalyticsRoutes } from './routes/crm-analytics';
import { customerStatusesRoutes } from './routes/customer-statuses';
import { leadsRoutes } from './routes/leads';
import { listsRoutes } from './routes/lists';
import { opportunitiesRoutes } from './routes/opportunities';
import { peopleRoutes } from './routes/people';
import { personCompaniesRoutes } from './routes/person-companies';
import { pipelineFieldVisibilityRoutes } from './routes/pipeline-field-visibility';
import { pipelineStagesRoutes } from './routes/pipeline-stages';
import { pipelinesRoutes } from './routes/pipelines';
import { customerSequencesRoutes, sequencesRoutes } from './routes/sequences';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'crm-api' });

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Object-based routes, in app-api's mount order.
app.route('/api/activities', activitiesRoutes);
app.route('/api/companies', companiesRoutes);
app.route('/api/crm-analytics', crmAnalyticsRoutes);
app.route('/api/customer-statuses', customerStatusesRoutes);
app.route('/api/leads', leadsRoutes);
app.route('/api/lists', listsRoutes);
app.route('/api/opportunities', opportunitiesRoutes);
app.route('/api/people', peopleRoutes);
app.route('/api/person-companies', personCompaniesRoutes);
app.route('/api/pipeline-field-visibility', pipelineFieldVisibilityRoutes);
app.route('/api/pipeline-stages', pipelineStagesRoutes);
app.route('/api/pipelines', pipelinesRoutes);
app.route('/api/sequences', sequencesRoutes);
app.route('/api/customer-sequences', customerSequencesRoutes);

// Cloudflare Workflow classes hosted by this worker (bound in wrangler.toml).
// CRM sequence execution, under the `execute-sequence-v3*` names: app-api
// keeps `execute-sequence-v2*` only while its in-flight instances drain.
export { ExecuteSequenceWorkflow } from '@weldsuite/crm-domain/workflows/execute-sequence';

export default {
  fetch: app.fetch,
};
