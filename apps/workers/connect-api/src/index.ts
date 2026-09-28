/**
 * WeldSuite connect-api — the connect module's API worker: WeldConnect
 * workflows (builder, dashboard, executions, schedules, templates, triggers,
 * variables, webhooks, GitHub), integrations and connectors, outbound
 * external webhooks, GitHub connections/links, the public workflow trigger
 * webhook, the GitHub App install callback and workflow-worker's internal
 * create_customer action.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { connectorRoutes } from './routes/connectors';
import { externalWebhooksRoutes } from './routes/external-webhooks';
import { githubConnectionsRoutes } from './routes/github-connections';
import { githubProjectLinksRoutes } from './routes/github-project-links';
import { githubRepoLinksRoutes } from './routes/github-repo-links';
import { integrationsRoutes } from './routes/integrations';
import { integrationsInternalRoutes } from './routes/integrations/internal';
import { internalWorkflowActionsRoutes } from './routes/internal-workflow-actions';
import { githubCallbackRoutes } from './routes/public-github-callback';
import { publicWorkflowWebhookRoutes } from './routes/public-workflow-webhook';
import { workflowBuilderRoutes } from './routes/workflow-builder';
import { workflowDashboardRoutes } from './routes/workflow-dashboard';
import { workflowExecutionsRoutes } from './routes/workflow-executions';
import { workflowGithubRoutes } from './routes/workflow-github';
import { workflowIntegrationsRoutes } from './routes/workflow-integrations';
import { workflowSchedulesRoutes } from './routes/workflow-schedules';
import { workflowTemplatesRoutes } from './routes/workflow-templates';
import { workflowTriggersRoutes } from './routes/workflow-triggers';
import { workflowVariablesRoutes } from './routes/workflow-variables';
import { workflowWebhooksRoutes } from './routes/workflow-webhooks';
import { workflowsRoutes } from './routes/workflows';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'connect-api' });

// GitHub App install callback — PUBLIC (no Clerk). GitHub's server-to-server
// redirect carries no session; auth is the state JWT signed at /install-url.
// Must stay ABOVE the app.use('/api/*', ...) guard below.
app.route('/api/weldconnect/github', githubCallbackRoutes);

// Internal service-to-service WeldConnect actions — PUBLIC mount (no Clerk).
// Auth is the in-route `Authorization: Bearer <INTERNAL_API_SECRET>` check.
// Caller: workflow-worker's create_customer action. Must stay ABOVE the
// /api/* guard.
app.route('/api/internal/workflow-actions', internalWorkflowActionsRoutes);

// External workflow trigger webhooks — PUBLIC. POST /:webhookId authenticates
// per-webhook (HMAC signature / IP allowlist) inside the receiver service.
// Mounted more specifically than the authed /api/workflows router below, so
// only /api/workflows/webhook/* bypasses Clerk. Must stay ABOVE the guard.
app.route('/api/workflows/webhook', publicWorkflowWebhookRoutes);

// The helpdesk Discord/Slack OAuth callbacks (/api/integrations/helpdesk) live
// in desk-api; @weldsuite/api-modules gives desk that longer prefix, so they
// never reach this worker.

// Internal (service-binding) integration endpoints — X-Internal-Secret auth
// for integration-sync-worker / integration-webhook-worker (they call app-api
// over their APP_API binding; its forwarder hands /api/integrations here).
// Handlers call next() when no internal headers are present, so normal
// platform traffic falls through to the Clerk-authed /api/integrations router
// mounted after the guard. Must stay ABOVE the /api/* guard.
app.route('/api/integrations', integrationsInternalRoutes);

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Object-based routes, in app-api's mount order.
app.route('/api/github-connections', githubConnectionsRoutes);
app.route('/api/github-repo-links', githubRepoLinksRoutes);
app.route('/api/github-project-links', githubProjectLinksRoutes);
app.route('/api/external-webhooks', externalWebhooksRoutes);
app.route('/api/integrations', integrationsRoutes);
app.route('/api/connectors', connectorRoutes);
app.route('/api/workflow-builder', workflowBuilderRoutes);
app.route('/api/workflow-dashboard', workflowDashboardRoutes);
app.route('/api/workflow-executions', workflowExecutionsRoutes);
app.route('/api/workflow-github', workflowGithubRoutes);
app.route('/api/workflow-integrations', workflowIntegrationsRoutes);
app.route('/api/workflow-schedules', workflowSchedulesRoutes);
app.route('/api/workflow-templates', workflowTemplatesRoutes);
app.route('/api/workflow-triggers', workflowTriggersRoutes);
app.route('/api/workflow-variables', workflowVariablesRoutes);
app.route('/api/workflow-webhooks', workflowWebhooksRoutes);
app.route('/api/workflows', workflowsRoutes);

export default {
  fetch: app.fetch,
};
