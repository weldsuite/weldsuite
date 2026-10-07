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

import { WorkerEntrypoint } from 'cloudflare:workers';
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
import { workflowVersionsRoutes } from './routes/workflow-versions';
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
// Caller: workflow-worker's create_customer action, now over ConnectInternal
// (below); this mount stays for the transition. Must stay ABOVE the /api/* guard.
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
// for integration-sync-worker / integration-webhook-worker. They now call
// ConnectInternal (below); this mount stays for the transition, reached over
// their APP_API binding (app-api's forwarder hands /api/integrations here).
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
app.route('/api/workflow-versions', workflowVersionsRoutes);
app.route('/api/workflow-webhooks', workflowWebhooksRoutes);
app.route('/api/workflows', workflowsRoutes);

export default {
  fetch: app.fetch,
};

// Internal entrypoint — bound as `CONNECT_INTERNAL` (entrypoint = "ConnectInternal")
// by integration-sync-worker, integration-webhook-worker and workflow-worker. A
// named entrypoint is only reachable over a service binding, so it is trusted by
// topology: the routes below accept `internalTrusted` instead of the
// INTERNAL_API_SECRET check. Only the internal routers are mounted here, at the
// same paths as on the public app; the public secret-guarded mounts above stay
// until every caller uses the entrypoint (docs/plans/app-api-module-split.md,
// rollout item 7).
const internalApp = createModuleApi<Env, Variables>({ service: 'connect-api' });
internalApp.use('*', async (c, next) => {
  c.set('internalTrusted', true);
  await next();
});
internalApp.route('/api/integrations', integrationsInternalRoutes);
internalApp.route('/api/internal/workflow-actions', internalWorkflowActionsRoutes);

export class ConnectInternal extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> | Response {
    return internalApp.fetch(request, this.env, this.ctx);
  }
}
