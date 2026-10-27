/**
 * Workspace AI agents — /api/weldagent/agents/*
 *
 * Agents are teammates with an owner: workspace permissions open the door
 * (`weldagent:read` / `use` / `update`), and each agent's owner decides who
 * can see and use it and is the one who changes it. `weldagent:manage` sees
 * and changes every agent. See @weldsuite/agent-domain/access.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission, ensurePermissionsResolved } from '@weldsuite/permissions/server';
import { hasPermission, type PermissionSubject } from '@weldsuite/permissions';
import {
  createWorkspaceAgentSchema,
  updateWorkspaceAgentSchema,
  updateWorkspaceAgentAccessSchema,
  updateWorkspaceAgentSubagentsSchema,
  runWorkspaceAgentSchema,
} from '@weldsuite/app-api-client/schemas/workspace-agents';
import type { Env, Variables } from '../../types';
import { error, success, noContent } from '@weldsuite/worker-kit/response';
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  listAgentRuns,
  checkSubagents,
  getSubagents,
  type SerializedAgent,
  type SubagentProblem,
} from '@weldsuite/agent-domain/agents';
import {
  canAccessAgent,
  canEditAgent,
  listAgentMemberIds,
  setAgentMembers,
  type AgentViewer,
} from '@weldsuite/agent-domain/access';
import { getOrCreateMainConversation, serializeConversationSummary } from '@weldsuite/agent-domain/main-chat';
import { extractEventSubscriptions } from '@weldsuite/agent-domain/subscriptions';
import { executeAgentRun } from '@weldsuite/agent-domain/run';
import { archiveManagedAgent } from '@weldsuite/agent-domain/managed-agents';
import { listToolCatalog, resolveAgentTools } from '@weldsuite/agent-domain/tools';
import { InsufficientAiCreditsError } from '@weldsuite/core-domain/ai-billing';
import { reindexAgentRoutines, routineIndexSync } from '@weldsuite/agent-domain/routine-index';
import { grantableAgentPermissions, granterHolds } from '@weldsuite/agent-domain/grants';
import { agentViewer } from '../../services/weldagent/viewer';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * Permissions in `requested` that the caller does not hold. Granting an agent
 * more than you have would let you act beyond your role through the agent.
 * Grants the agent already has are left alone so a teammate can still edit it.
 */
async function ungrantablePermissions(
  c: Parameters<typeof ensurePermissionsResolved>[0],
  requested: string[] | undefined,
  existing: string[] = [],
): Promise<string[]> {
  if (!requested) return [];
  const resolved = await ensurePermissionsResolved(c);
  const held: PermissionSubject = resolved ?? { permissions: [] };
  return requested.filter((perm) => !existing.includes(perm) && !granterHolds(held, perm));
}

function withCapabilities(agent: SerializedAgent, viewer: AgentViewer) {
  return { ...agent, capabilities: { canEdit: canEditAgent(agent, viewer) } };
}

/**
 * The agent when the caller may see it (`mode: 'access'`) or change it
 * (`mode: 'edit'`); otherwise the error response to return. An agent the
 * caller can't see is a 404, like any record outside your reach.
 */
async function resolveAgent(
  c: AppContext,
  id: string,
  mode: 'access' | 'edit',
): Promise<{ agent: SerializedAgent; viewer: AgentViewer } | { response: Response }> {
  const db = c.get('tenantDb');
  const agent = await getAgent(db, id);
  if (!agent) return { response: error.notFound(c, 'Agent not found') };
  const viewer = await agentViewer(c);
  if (!(await canAccessAgent(db, agent, viewer))) return { response: error.notFound(c, 'Agent not found') };
  if (mode === 'edit' && !canEditAgent(agent, viewer)) {
    return { response: error.forbidden(c, 'Only the agent\'s owner can change it') };
  }
  return { agent, viewer };
}

function subagentProblemMessage(problem: SubagentProblem): string {
  switch (problem.code) {
    case 'self':
      return 'An agent can\'t be its own sub-agent; use "copies of itself" instead';
    case 'too_many':
      return `An agent can have at most ${problem.max} sub-agents`;
    case 'not_found':
      return `Sub-agent not found: ${problem.agentId}`;
    case 'duplicate_name':
      return `Sub-agents need distinct names; "${problem.agentName}" is used twice`;
  }
}

/** GET /agents — the workspace agents the caller can see. */
app.get('/', requirePermission('weldagent:read'), async (c) => {
  const db = c.get('tenantDb');
  const status = c.req.query('status') || undefined;
  try {
    const viewer = await agentViewer(c);
    const agents = await listAgents(db, status, viewer);
    return success(c, agents.map((agent) => withCapabilities(agent, viewer)));
  } catch (err) {
    console.error('[weldagent/agents] list failed:', err);
    return error.internal(c, 'Failed to list agents');
  }
});

/** GET /agents/tools — tool catalog for the builder UI. */
app.get('/tools', requirePermission('weldagent:read'), (c) => {
  return success(c, listToolCatalog());
});

/** GET /agents/grantable-permissions — platform permissions assignable to an agent. */
app.get('/grantable-permissions', requirePermission('weldagent:read'), (c) => {
  return success(c, grantableAgentPermissions());
});

/** POST /agents — create a draft agent, owned by the caller. */
app.post('/', requirePermission('weldagent:create', 'weldagent:manage'), zValidator('json', createWorkspaceAgentSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const denied = await ungrantablePermissions(c, data.permissions);
  if (denied.length > 0) {
    return error.forbidden(c, `You can't grant permissions you don't have: ${denied.join(', ')}`);
  }
  // Sandbox + web grants on by default, only when the creator holds them.
  const held = (await ensurePermissionsResolved(c))?.permissions ?? [];
  const permissions =
    data.permissions ?? ['computer:use', 'browser:use'].filter((p) => hasPermission(held, p));
  try {
    const agent = await createAgent(db, {
      ...data,
      permissions,
      createdBy: c.get('userId'),
    });
    return success(c, withCapabilities(agent, await agentViewer(c)), 201);
  } catch (err) {
    console.error('[weldagent/agents] create failed:', err);
    return error.internal(c, 'Failed to create agent');
  }
});

/** GET /agents/:id */
app.get('/:id', requirePermission('weldagent:read'), async (c) => {
  const resolved = await resolveAgent(c, c.req.param('id'), 'access');
  if ('response' in resolved) return resolved.response;
  const { agent, viewer } = resolved;
  const tools = resolveAgentTools(agent.permissions, agent.enabledTools).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    requiredPermissions: t.requiredPermissions,
  }));
  const memberIds = await listAgentMemberIds(c.get('tenantDb'), agent.id);
  return success(c, { ...withCapabilities(agent, viewer), memberIds, availableTools: tools });
});

/** PATCH /agents/:id */
app.patch('/:id', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', updateWorkspaceAgentSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const resolved = await resolveAgent(c, id, 'edit');
  if ('response' in resolved) return resolved.response;
  const denied = await ungrantablePermissions(c, data.permissions, resolved.agent.permissions);
  if (denied.length > 0) {
    return error.forbidden(c, `You can't grant permissions you don't have: ${denied.join(', ')}`);
  }
  try {
    const agent = await updateAgent(db, id, data);
    if (!agent) return error.notFound(c, 'Agent not found');
    if (data.status !== undefined) {
      await reindexAgentRoutines(routineIndexSync(c.env, c.get('clerkOrgId')), db, id);
    }
    return success(c, withCapabilities(agent, resolved.viewer));
  } catch (err) {
    console.error('[weldagent/agents] update failed:', err);
    return error.internal(c, 'Failed to update agent');
  }
});

/** PUT /agents/:id/access — owner, visibility and members. */
app.put(
  '/:id/access',
  requirePermission('weldagent:update', 'weldagent:manage'),
  zValidator('json', updateWorkspaceAgentAccessSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    const resolved = await resolveAgent(c, id, 'edit');
    if ('response' in resolved) return resolved.response;
    try {
      if (data.memberIds) await setAgentMembers(db, id, data.memberIds, c.get('userId'));
      const agent = await updateAgent(db, id, {
        ownerId: data.ownerId,
        visibility: data.visibility,
      });
      if (!agent) return error.notFound(c, 'Agent not found');
      const memberIds = await listAgentMemberIds(db, id);
      return success(c, { ...withCapabilities(agent, resolved.viewer), memberIds });
    } catch (err) {
      console.error('[weldagent/agents] update access failed:', err);
      return error.internal(c, 'Failed to update agent access');
    }
  },
);

/** PUT /agents/:id/subagents — the agents this agent may hand work to. */
app.put(
  '/:id/subagents',
  requirePermission('weldagent:update', 'weldagent:manage'),
  zValidator('json', updateWorkspaceAgentSubagentsSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    const resolved = await resolveAgent(c, id, 'edit');
    if ('response' in resolved) return resolved.response;
    const requested = [...new Set(data.subagentIds)];
    const stored = new Set(resolved.agent.subagentIds);

    // You can only add teammates you can reach yourself. Ids already stored
    // (e.g. added by a manager) are not re-checked, so a save that only flips
    // "copies of itself" never fails on them.
    for (const subId of requested.filter((id) => !stored.has(id))) {
      const sub = await getAgent(db, subId);
      if (!sub || !(await canAccessAgent(db, sub, resolved.viewer))) {
        return error.badRequest(c, `Sub-agent not found: ${subId}`);
      }
    }
    // Agents deleted since they were picked drop out of the list.
    const live = new Set((await getSubagents(db, requested)).map((sub) => sub.id));
    const subagentIds = requested.filter((id) => live.has(id));
    const problem = await checkSubagents(db, resolved.agent, subagentIds);
    if (problem) return error.badRequest(c, subagentProblemMessage(problem));

    try {
      const agent = await updateAgent(db, id, { subagentIds, delegateToSelf: data.delegateToSelf });
      if (!agent) return error.notFound(c, 'Agent not found');
      return success(c, withCapabilities(agent, resolved.viewer));
    } catch (err) {
      console.error('[weldagent/agents] update sub-agents failed:', err);
      return error.internal(c, 'Failed to update sub-agents');
    }
  },
);

/** POST /agents/:id/chat — the caller's one continuous chat with the agent. */
app.post('/:id/chat', requirePermission('weldagent:use'), async (c) => {
  const resolved = await resolveAgent(c, c.req.param('id'), 'access');
  if ('response' in resolved) return resolved.response;
  try {
    const conversation = await getOrCreateMainConversation(c.get('tenantDb'), {
      userId: c.get('userId'),
      agentId: resolved.agent.id,
      agentName: resolved.agent.name,
    });
    return success(c, serializeConversationSummary(conversation));
  } catch (err) {
    console.error('[weldagent/agents] open main chat failed:', err);
    return error.internal(c, 'Failed to open the chat');
  }
});

/** DELETE /agents/:id */
app.delete('/:id', requirePermission('weldagent:delete', 'weldagent:manage'), async (c) => {
  const db = c.get('tenantDb');
  const resolved = await resolveAgent(c, c.req.param('id'), 'edit');
  if ('response' in resolved) return resolved.response;
  const deleted = await deleteAgent(db, resolved.agent.id);
  if (!deleted) return error.notFound(c, 'Agent not found');
  await reindexAgentRoutines(routineIndexSync(c.env, c.get('clerkOrgId')), db, resolved.agent.id);
  c.executionCtx.waitUntil(archiveManagedAgent(c.env, deleted.anthropicAgentId));
  return noContent(c);
});

/** POST /agents/:id/activate — set active and extract event subscriptions from instructions. */
app.post('/:id/activate', requirePermission('weldagent:update', 'weldagent:manage'), async (c) => {
  const db = c.get('tenantDb');
  const resolved = await resolveAgent(c, c.req.param('id'), 'edit');
  if ('response' in resolved) return resolved.response;
  const id = resolved.agent.id;

  const subscriptions = extractEventSubscriptions(resolved.agent.systemPrompt);
  const agent = await updateAgent(db, id, {
    status: 'active',
    eventSubscriptions: subscriptions,
  });
  await reindexAgentRoutines(routineIndexSync(c.env, c.get('clerkOrgId')), db, id);
  return success(c, agent ? withCapabilities(agent, resolved.viewer) : agent);
});

/** POST /agents/:id/pause */
app.post('/:id/pause', requirePermission('weldagent:update', 'weldagent:manage'), async (c) => {
  const db = c.get('tenantDb');
  const resolved = await resolveAgent(c, c.req.param('id'), 'edit');
  if ('response' in resolved) return resolved.response;
  const agent = await updateAgent(db, resolved.agent.id, { status: 'paused' });
  if (!agent) return error.notFound(c, 'Agent not found');
  await reindexAgentRoutines(routineIndexSync(c.env, c.get('clerkOrgId')), db, agent.id);
  return success(c, withCapabilities(agent, resolved.viewer));
});

/** GET /agents/:id/runs */
app.get('/:id/runs', requirePermission('weldagent:read'), async (c) => {
  const db = c.get('tenantDb');
  const resolved = await resolveAgent(c, c.req.param('id'), 'access');
  if ('response' in resolved) return resolved.response;
  const limit = Math.min(Number.parseInt(c.req.query('limit') || '50', 10), 100);
  const runs = await listAgentRuns(db, resolved.agent.id, limit);
  return success(c, runs);
});

/** POST /agents/:id/run — manual run. */
app.post(
  '/:id/run',
  requirePermission('weldagent:use'),
  zValidator('json', runWorkspaceAgentSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json');
    const resolved = await resolveAgent(c, c.req.param('id'), 'access');
    if ('response' in resolved) return resolved.response;
    const id = resolved.agent.id;

    try {
      const result = await executeAgentRun({
        db,
        env: c.env,
        // The agent runtime keeps the Clerk org id: it reaches Anthropic metadata, the
        // sandbox id and WeldAgent job params (workspace-id plan).
        workspaceId: c.get('clerkOrgId'),
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
