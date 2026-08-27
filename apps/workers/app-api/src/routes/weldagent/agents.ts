/**
 * Workspace AI agents — /api/weldagent/agents/*
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { getAllPermissionKeys } from '@weldsuite/permissions/catalog';
import {
  createWorkspaceAgentSchema,
  updateWorkspaceAgentSchema,
  runWorkspaceAgentSchema,
} from '@weldsuite/app-api-client/schemas/workspace-agents';
import type { Env, Variables } from '../../types';
import { error, success, noContent } from '../../lib/response';
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  listAgentRuns,
} from '../../services/weldagent/agents';
import { extractEventSubscriptions } from '../../services/weldagent/subscriptions';
import { executeAgentRun } from '../../services/weldagent/run';
import { listToolCatalog, resolveAgentTools } from '../../services/weldagent/tools';
import { InsufficientAiCreditsError } from '../../services/ai/billing';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** GET /agents — list workspace agents. */
app.get('/', requirePermission('weldagent:read'), async (c) => {
  const db = c.get('tenantDb');
  const status = c.req.query('status') || undefined;
  try {
    const agents = await listAgents(db, status);
    return success(c, agents);
  } catch (err) {
    console.error('[weldagent/agents] list failed:', err);
    return error.internal(c, 'Failed to list agents');
  }
});

/** GET /agents/tools — tool catalog for the builder UI. */
app.get('/tools', requirePermission('weldagent:read'), async (c) => {
  return success(c, listToolCatalog());
});

/** GET /agents/grantable-permissions — platform permissions assignable to an agent. */
app.get('/grantable-permissions', requirePermission('weldagent:read'), async (c) => {
  // Exclude weldagent:* self-management and settings noise — agents act on data objects.
  const keys = getAllPermissionKeys().filter(
    (k) =>
      !k.startsWith('weldagent:') &&
      !k.startsWith('team:') &&
      !k.startsWith('roles:') &&
      !k.startsWith('apikeys:') &&
      !k.startsWith('billing:') &&
      !k.startsWith('general:'),
  );
  return success(c, keys);
});

/** POST /agents — create a draft agent. */
app.post('/', requirePermission('weldagent:create', 'weldagent:manage'), zValidator('json', createWorkspaceAgentSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const agent = await createAgent(db, {
      ...data,
      createdBy: c.get('userId'),
    });
    return success(c, agent, 201);
  } catch (err) {
    console.error('[weldagent/agents] create failed:', err);
    return error.internal(c, 'Failed to create agent');
  }
});

/** GET /agents/:id */
app.get('/:id', requirePermission('weldagent:read'), async (c) => {
  const db = c.get('tenantDb');
  const agent = await getAgent(db, c.req.param('id'));
  if (!agent) return error.notFound(c, 'Agent not found');
  const tools = resolveAgentTools(agent.permissions, agent.enabledTools).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    requiredPermissions: t.requiredPermissions,
  }));
  return success(c, { ...agent, availableTools: tools });
});

/** PATCH /agents/:id */
app.patch('/:id', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', updateWorkspaceAgentSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const agent = await updateAgent(db, id, data);
    if (!agent) return error.notFound(c, 'Agent not found');
    return success(c, agent);
  } catch (err) {
    console.error('[weldagent/agents] update failed:', err);
    return error.internal(c, 'Failed to update agent');
  }
});

/** DELETE /agents/:id */
app.delete('/:id', requirePermission('weldagent:delete', 'weldagent:manage'), async (c) => {
  const db = c.get('tenantDb');
  const ok = await deleteAgent(db, c.req.param('id'));
  if (!ok) return error.notFound(c, 'Agent not found');
  return noContent(c);
});

/** POST /agents/:id/activate — set active and extract event subscriptions from instructions. */
app.post('/:id/activate', requirePermission('weldagent:update', 'weldagent:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await getAgent(db, id);
  if (!existing) return error.notFound(c, 'Agent not found');

  const subscriptions = extractEventSubscriptions(existing.systemPrompt);
  const agent = await updateAgent(db, id, {
    status: 'active',
    eventSubscriptions: subscriptions,
  });
  return success(c, agent);
});

/** POST /agents/:id/pause */
app.post('/:id/pause', requirePermission('weldagent:update', 'weldagent:manage'), async (c) => {
  const db = c.get('tenantDb');
  const agent = await updateAgent(db, c.req.param('id'), { status: 'paused' });
  if (!agent) return error.notFound(c, 'Agent not found');
  return success(c, agent);
});

/** GET /agents/:id/runs */
app.get('/:id/runs', requirePermission('weldagent:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await getAgent(db, id);
  if (!existing) return error.notFound(c, 'Agent not found');
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const runs = await listAgentRuns(db, id, limit);
  return success(c, runs);
});

/** POST /agents/:id/run — manual run. */
app.post(
  '/:id/run',
  requirePermission('weldagent:use'),
  zValidator('json', runWorkspaceAgentSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const existing = await getAgent(db, id);
    if (!existing) return error.notFound(c, 'Agent not found');

    try {
      const result = await executeAgentRun({
        db,
        env: c.env,
        workspaceId: c.get('workspaceId'),
        actorUserId: c.get('userId'),
        agentId: id,
        triggerType: 'manual',
        triggerData: body.triggerData,
        userMessage:
          body.message ??
          'Run now according to your instructions. Use tools if needed and summarise what you did.',
      });
      return success(c, result);
    } catch (err) {
      if (err instanceof InsufficientAiCreditsError) {
        return error.insufficientCredits(c, {
          currentBalance: err.currentBalance,
          required: err.required,
          shortfall: err.shortfall,
        });
      }
      console.error('[weldagent/agents] run failed:', err);
      return error.internal(c, err instanceof Error ? err.message : 'Agent run failed');
    }
  },
);

export const weldagentAgentsRoutes = app;
