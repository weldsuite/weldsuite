/**
 * WeldConnect API router — mounts all workflow-related route groups under
 * `/api/weldconnect/*` with canonical short segment names.
 *
 * Legacy flat mounts (`/api/workflows`, `/api/workflow-executions`, …) remain
 * as aliases in `src/index.ts` during the cutover window.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { workflowBuilderRoutes } from '../workflow-builder';
import { workflowDashboardRoutes } from '../workflow-dashboard';
import { workflowExecutionsRoutes } from '../workflow-executions';
import { workflowGithubRoutes } from '../workflow-github';
import { workflowIntegrationsRoutes } from '../workflow-integrations';
import { workflowSchedulesRoutes } from '../workflow-schedules';
import { workflowTemplatesRoutes } from '../workflow-templates';
import { workflowTriggersRoutes } from '../workflow-triggers';
import { workflowVariablesRoutes } from '../workflow-variables';
import { workflowWebhooksRoutes } from '../workflow-webhooks';
import { workflowsRoutes } from '../workflows';
import { nangoRoutes } from '../nango';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.route('/workflows', workflowsRoutes);
app.route('/executions', workflowExecutionsRoutes);
app.route('/templates', workflowTemplatesRoutes);
app.route('/variables', workflowVariablesRoutes);
app.route('/webhooks', workflowWebhooksRoutes);
app.route('/schedules', workflowSchedulesRoutes);
app.route('/integrations', workflowIntegrationsRoutes);
app.route('/nango', nangoRoutes);
app.route('/builder', workflowBuilderRoutes);
app.route('/dashboard', workflowDashboardRoutes);
app.route('/github', workflowGithubRoutes);
app.route('/triggers', workflowTriggersRoutes);

// Legacy segment names under the namespace (clients mid-migration).
app.route('/workflow-executions', workflowExecutionsRoutes);
app.route('/workflow-templates', workflowTemplatesRoutes);
app.route('/workflow-variables', workflowVariablesRoutes);
app.route('/workflow-webhooks', workflowWebhooksRoutes);
app.route('/workflow-schedules', workflowSchedulesRoutes);
app.route('/workflow-integrations', workflowIntegrationsRoutes);
app.route('/workflow-builder', workflowBuilderRoutes);
app.route('/workflow-dashboard', workflowDashboardRoutes);
app.route('/workflow-github', workflowGithubRoutes);
app.route('/workflow-triggers', workflowTriggersRoutes);

export const weldconnectRoutes = app;
