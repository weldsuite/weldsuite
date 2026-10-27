/**
 * WeldAgent Grok-parity routes — skills, routines, approvals, memory, templates, teach, connectors.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission, ensurePermissionsResolved } from '@weldsuite/permissions/server';
import {
  createSkillSchema,
  updateSkillSchema,
  createRoutineSchema,
  updateRoutineSchema,
  decideApprovalSchema,
  createMemorySchema,
  updateMemorySchema,
  exportTemplateSchema,
  installTemplateSchema,
  startTeachSchema,
  appendTeachStepSchema,
  stopTeachSchema,
  connectorEventSchema,
} from '@weldsuite/app-api-client/schemas/weldagent-parity';
import type { Env, Variables } from '../../types';
import { error, success, noContent } from '@weldsuite/worker-kit/response';
import {
  listSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  listAgentSkills,
  enableSkillForAgent,
  disableSkillForAgent,
  listRoutines,
  getRoutine,
  createRoutine,
  updateRoutine,
  deleteRoutine,
  listRoutineRuns,
  createRoutineRun,
  markRoutineScheduled,
  findConnectorRoutines,
  listApprovals,
  getApproval,
  decideApproval,
  listMemories,
  getMemory,
  createMemory,
  updateMemory,
  deleteMemory,
  exportAgentTemplate,
  getTemplate,
  getTemplateByShareToken,
  installTemplate,
  startTeachSession,
  getTeachSessionAgentId,
  appendTeachStep,
  stopTeachSession,
} from '@weldsuite/agent-domain/parity';
import { getAgent, listAgents } from '@weldsuite/agent-domain/agents';
import { canAccessAgent, canEditAgent } from '@weldsuite/agent-domain/access';
import { granterHolds } from '@weldsuite/agent-domain/grants';
import { enqueueWeldAgentJob } from '@weldsuite/agent-domain/jobs';
import { executeDecidedApproval } from '../../services/weldagent/approvals';
import { agentViewer } from '../../services/weldagent/viewer';
import { reindexAgentRoutines, routineIndexSync } from '@weldsuite/agent-domain/routine-index';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * The error response when the caller may not see (`access`) or change
 * (`edit`) the agent, else null. Routines, memories, skills and teaching
 * belong to an agent, so its owner is the one who changes them.
 */
async function agentGuard(c: AppContext, agentId: string, mode: 'access' | 'edit'): Promise<Response | null> {
  const db = c.get('tenantDb');
  const agent = await getAgent(db, agentId);
  const viewer = await agentViewer(c);
  if (!agent || !(await canAccessAgent(db, agent, viewer))) return error.notFound(c, 'Agent not found');
  if (mode === 'edit' && !canEditAgent(agent, viewer)) {
    return error.forbidden(c, 'Only the agent\'s owner can change it');
  }
  return null;
}

// ----- Skills -----
app.get('/skills', requirePermission('weldagent:read'), async (c) => {
  const skills = await listSkills(c.get('tenantDb'), c.req.query('status') || undefined);
  return success(c, skills);
});

app.post('/skills', requirePermission('weldagent:create', 'weldagent:manage'), zValidator('json', createSkillSchema), async (c) => {
  const data = c.req.valid('json');
  const skill = await createSkill(c.get('tenantDb'), { ...data, createdBy: c.get('userId') });
  return success(c, skill, 201);
});

app.patch('/skills/:id', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', updateSkillSchema), async (c) => {
  const skill = await updateSkill(c.get('tenantDb'), c.req.param('id'), c.req.valid('json'));
  if (!skill) return error.notFound(c, 'Skill not found');
  return success(c, skill);
});

app.delete('/skills/:id', requirePermission('weldagent:manage', 'weldagent:update'), async (c) => {
  const ok = await deleteSkill(c.get('tenantDb'), c.req.param('id'));
  if (!ok) return error.notFound(c, 'Skill not found');
  return noContent(c);
});

app.get('/agents/:id/skills', requirePermission('weldagent:read'), async (c) => {
  const denied = await agentGuard(c, c.req.param('id'), 'access');
  if (denied) return denied;
  return success(c, await listAgentSkills(c.get('tenantDb'), c.req.param('id')));
});

app.post('/agents/:id/skills/:skillId', requirePermission('weldagent:update', 'weldagent:manage'), async (c) => {
  const denied = await agentGuard(c, c.req.param('id'), 'edit');
  if (denied) return denied;
  const skill = await enableSkillForAgent(c.get('tenantDb'), c.req.param('id'), c.req.param('skillId'));
  if (!skill) return error.notFound(c, 'Skill not found');
  return success(c, skill);
});

app.delete('/agents/:id/skills/:skillId', requirePermission('weldagent:update', 'weldagent:manage'), async (c) => {
  const denied = await agentGuard(c, c.req.param('id'), 'edit');
  if (denied) return denied;
  await disableSkillForAgent(c.get('tenantDb'), c.req.param('id'), c.req.param('skillId'));
  return noContent(c);
});

// ----- Routines -----
app.get('/routines', requirePermission('weldagent:read'), async (c) => {
  const agentId = c.req.query('agentId') || undefined;
  if (agentId) {
    const denied = await agentGuard(c, agentId, 'access');
    if (denied) return denied;
    return success(c, await listRoutines(c.get('tenantDb'), agentId));
  }
  const visible = new Set((await listAgents(c.get('tenantDb'), undefined, await agentViewer(c))).map((a) => a.id));
  const routines = await listRoutines(c.get('tenantDb'));
  return success(c, routines.filter((routine) => visible.has(routine.agentId)));
});

app.post('/routines', requirePermission('weldagent:create', 'weldagent:manage'), zValidator('json', createRoutineSchema), async (c) => {
  const data = c.req.valid('json');
  const denied = await agentGuard(c, data.agentId, 'edit');
  if (denied) return denied;
  const routine = await createRoutine(c.get('tenantDb'), { ...data, createdBy: c.get('userId') });
  await reindexAgentRoutines(routineIndexSync(c.env, c.get('clerkOrgId')), c.get('tenantDb'), routine.agentId);
  return success(c, routine, 201);
});

app.patch('/routines/:id', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', updateRoutineSchema), async (c) => {
  const existing = await getRoutine(c.get('tenantDb'), c.req.param('id'));
  if (!existing) return error.notFound(c, 'Routine not found');
  const denied = await agentGuard(c, existing.agentId, 'edit');
  if (denied) return denied;
  const routine = await updateRoutine(c.get('tenantDb'), c.req.param('id'), c.req.valid('json'));
  if (!routine) return error.notFound(c, 'Routine not found');
  await reindexAgentRoutines(routineIndexSync(c.env, c.get('clerkOrgId')), c.get('tenantDb'), routine.agentId);
  return success(c, routine);
});

app.delete('/routines/:id', requirePermission('weldagent:manage', 'weldagent:update'), async (c) => {
  const existing = await getRoutine(c.get('tenantDb'), c.req.param('id'));
  if (!existing) return error.notFound(c, 'Routine not found');
  const denied = await agentGuard(c, existing.agentId, 'edit');
  if (denied) return denied;
  const ok = await deleteRoutine(c.get('tenantDb'), c.req.param('id'));
  if (!ok || !existing) return error.notFound(c, 'Routine not found');
  await reindexAgentRoutines(routineIndexSync(c.env, c.get('clerkOrgId')), c.get('tenantDb'), existing.agentId);
  return noContent(c);
});

app.get('/routines/:id/runs', requirePermission('weldagent:read'), async (c) => {
  const routine = await getRoutine(c.get('tenantDb'), c.req.param('id'));
  if (!routine) return error.notFound(c, 'Routine not found');
  const denied = await agentGuard(c, routine.agentId, 'access');
  if (denied) return denied;
  return success(c, await listRoutineRuns(c.get('tenantDb'), c.req.param('id'), 20));
});

app.post('/routines/:id/test', requirePermission('weldagent:update', 'weldagent:manage'), async (c) => {
  const db = c.get('tenantDb');
  const routine = await getRoutine(db, c.req.param('id'));
  if (!routine) return error.notFound(c, 'Routine not found');
  const denied = await agentGuard(c, routine.agentId, 'edit');
  if (denied) return denied;
  const runId = await createRoutineRun(db, {
    routineId: routine.id,
    agentId: routine.agentId,
    trigger: 'test',
  });
  // Durable job: a test run is a full agent run and can outlive the request.
  // The outcome lands on the routine run row and the agent's activity.
  await enqueueWeldAgentJob(
    c.env,
    (p) => c.executionCtx.waitUntil(p),
    {
      kind: 'agent-run',
      // WeldAgent job params carry the Clerk org id (workspace-id plan).
      workspaceId: c.get('clerkOrgId'),
      actorUserId: c.get('userId'),
      agentId: routine.agentId,
      triggerType: 'manual',
      triggerData: { routineId: routine.id, test: true },
      userMessage: `Run routine "${routine.name}" as a test.\n\n${routine.instructions}`,
      extraSystem: 'This is a routine test run. Prefer draft/recommend over irreversible actions.',
      routineRunId: runId,
      skipApprovals: !routine.requireApproval,
    },
    db,
  );
  return success(c, { queued: true, runId });
});

app.get('/approvals', requirePermission('weldagent:read'), async (c) => {
  const agentId = c.req.query('agentId') || undefined;
  if (agentId) {
    const denied = await agentGuard(c, agentId, 'access');
    if (denied) return denied;
  }
  const approvals = await listApprovals(c.get('tenantDb'), {
    agentId,
    status: c.req.query('status') || 'pending',
  });
  if (agentId) return success(c, approvals);
  const visible = new Set((await listAgents(c.get('tenantDb'), undefined, await agentViewer(c))).map((a) => a.id));
  return success(c, approvals.filter((approval) => visible.has(approval.agentId)));
});

/**
 * Decide an approval: the agent's owner (its manager), whoever's request
 * raised it, or a holder of weldagent:manage.
 */
app.post('/approvals/:id/decide', requirePermission('weldagent:use', 'weldagent:update', 'weldagent:manage'), zValidator('json', decideApprovalSchema), async (c) => {
  const data = c.req.valid('json');
  const pending = await getApproval(c.get('tenantDb'), c.req.param('id'));
  if (!pending) return error.notFound(c, 'Approval not found or already decided');
  const agent = await getAgent(c.get('tenantDb'), pending.agentId);
  const viewer = await agentViewer(c);
  // An ownerless (legacy) agent keeps the old rule: anyone who may edit agents.
  const resolvedPerms = await ensurePermissionsResolved(c);
  const ownerSide = agent?.ownerId
    ? canEditAgent(agent, viewer)
    : Boolean(resolvedPerms && granterHolds(resolvedPerms, 'weldagent:update'));
  const mayDecide = viewer.canManageAll || pending.createdBy === viewer.userId || ownerSide;
  if (!mayDecide) return error.forbidden(c, 'Only the agent\'s owner or the person who asked can decide this');
  const approval = await decideApproval(c.get('tenantDb'), c.req.param('id'), {
    decision: data.decision,
    decidedBy: c.get('userId'),
    reason: data.reason,
  });
  if (!approval) return error.notFound(c, 'Approval not found or already decided');
  const resolved = await ensurePermissionsResolved(c);
  const execution = await executeDecidedApproval({
    db: c.get('tenantDb'),
    env: c.env,
    workspaceId: c.get('clerkOrgId'),
    approval,
    deciderUserId: c.get('userId'),
    deciderPermissions: resolved?.permissions ?? [],
  });
  return success(c, { ...approval, execution });
});

// ----- Memory -----
app.get('/agents/:id/memories', requirePermission('weldagent:read'), async (c) => {
  const denied = await agentGuard(c, c.req.param('id'), 'access');
  if (denied) return denied;
  return success(c, await listMemories(c.get('tenantDb'), c.req.param('id')));
});

app.post('/memories', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', createMemorySchema), async (c) => {
  const data = c.req.valid('json');
  const denied = await agentGuard(c, data.agentId, 'edit');
  if (denied) return denied;
  const memory = await createMemory(c.get('tenantDb'), { ...data, createdBy: c.get('userId') });
  return success(c, memory, 201);
});

app.patch('/memories/:id', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', updateMemorySchema), async (c) => {
  const existing = await getMemory(c.get('tenantDb'), c.req.param('id'));
  if (!existing) return error.notFound(c, 'Memory not found');
  const denied = await agentGuard(c, existing.agentId, 'edit');
  if (denied) return denied;
  const memory = await updateMemory(c.get('tenantDb'), c.req.param('id'), c.req.valid('json'));
  if (!memory) return error.notFound(c, 'Memory not found');
  return success(c, memory);
});

app.delete('/memories/:id', requirePermission('weldagent:update', 'weldagent:manage'), async (c) => {
  const existing = await getMemory(c.get('tenantDb'), c.req.param('id'));
  if (!existing) return noContent(c);
  const denied = await agentGuard(c, existing.agentId, 'edit');
  if (denied) return denied;
  await deleteMemory(c.get('tenantDb'), c.req.param('id'));
  return noContent(c);
});

// ----- Templates -----
app.post('/templates/export', requirePermission('weldagent:create', 'weldagent:manage'), zValidator('json', exportTemplateSchema), async (c) => {
  const data = c.req.valid('json');
  // The template carries the agent's prompt, grants, routines and memories
  // plus a bearer share token, so only the agent's owner may export it.
  const denied = await agentGuard(c, data.agentId, 'edit');
  if (denied) return denied;
  const template = await exportAgentTemplate(c.get('tenantDb'), { ...data, createdBy: c.get('userId') });
  if (!template) return error.notFound(c, 'Agent not found');
  return success(c, template, 201);
});

app.get('/templates/:id', requirePermission('weldagent:read'), async (c) => {
  const template = await getTemplate(c.get('tenantDb'), c.req.param('id'));
  if (!template) return error.notFound(c, 'Template not found');
  return success(c, template);
});

app.get('/templates/share/:token', requirePermission('weldagent:read'), async (c) => {
  const template = await getTemplateByShareToken(c.get('tenantDb'), c.req.param('token'));
  if (!template) return error.notFound(c, 'Template not found');
  return success(c, template);
});

app.post('/templates/install', requirePermission('weldagent:create', 'weldagent:manage'), zValidator('json', installTemplateSchema), async (c) => {
  const data = c.req.valid('json');
  if (!data.templateId && !data.shareToken) {
    return error.badRequest(c, 'templateId or shareToken required');
  }
  const agent = await installTemplate(c.get('tenantDb'), { ...data, createdBy: c.get('userId') });
  if (!agent) return error.notFound(c, 'Template not found');
  await reindexAgentRoutines(routineIndexSync(c.env, c.get('clerkOrgId')), c.get('tenantDb'), agent.id);
  return success(c, agent, 201);
});

// ----- Teach -----
app.post('/agents/:id/teach/start', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', startTeachSchema), async (c) => {
  const denied = await agentGuard(c, c.req.param('id'), 'edit');
  if (denied) return denied;
  const agent = await getAgent(c.get('tenantDb'), c.req.param('id'));
  if (!agent) return error.notFound(c, 'Agent not found');
  const session = await startTeachSession(c.get('tenantDb'), {
    agentId: agent.id,
    title: c.req.valid('json').title,
    createdBy: c.get('userId'),
  });
  return success(c, session, 201);
});

app.post('/teach/:id/steps', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', appendTeachStepSchema), async (c) => {
  const sessionAgentId = await getTeachSessionAgentId(c.get('tenantDb'), c.req.param('id'));
  if (!sessionAgentId) return error.notFound(c, 'Teach session not found or not recording');
  const denied = await agentGuard(c, sessionAgentId, 'edit');
  if (denied) return denied;
  const session = await appendTeachStep(c.get('tenantDb'), c.req.param('id'), c.req.valid('json').step);
  if (!session) return error.notFound(c, 'Teach session not found or not recording');
  return success(c, session);
});

app.post('/teach/:id/stop', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', stopTeachSchema), async (c) => {
  const data = c.req.valid('json');
  const sessionAgentId = await getTeachSessionAgentId(c.get('tenantDb'), c.req.param('id'));
  if (!sessionAgentId) return error.notFound(c, 'Teach session not found');
  const denied = await agentGuard(c, sessionAgentId, 'edit');
  if (denied) return denied;
  const session = await stopTeachSession(c.get('tenantDb'), c.req.param('id'), {
    createSkill: data.createSkill,
    skillName: data.skillName,
    createdBy: c.get('userId'),
  });
  if (!session) return error.notFound(c, 'Teach session not found');
  return success(c, session);
});

// ----- Connector events (Slack / GitHub) -----
app.post('/connectors/events', requirePermission('weldagent:manage', 'weldagent:update'), zValidator('json', connectorEventSchema), async (c) => {
  const data = c.req.valid('json');
  const db = c.get('tenantDb');
  const matches = await findConnectorRoutines(db, {
    provider: data.provider,
    channel: data.channel,
    repo: data.repo,
    event: data.event,
    text: data.text,
  });
  // At most five routines, each with its own run row and job: start them together.
  // allSettled so one failure doesn't hide the runs that did start (a retried
  // event would otherwise start them a second time).
  const settled = await Promise.allSettled(
    matches.slice(0, 5).map(async (routine) => {
      const runId = await createRoutineRun(db, {
        routineId: routine.id,
        agentId: routine.agentId,
        trigger: `connector:${data.provider}`,
      });
      await markRoutineScheduled(db, routine);
      // Durable job: the agent run outlives the ~30s waitUntil budget.
      await enqueueWeldAgentJob(
        c.env,
        (p) => c.executionCtx.waitUntil(p),
        {
          kind: 'agent-run',
          workspaceId: c.get('clerkOrgId'),
          actorUserId: c.get('userId'),
          agentId: routine.agentId,
          triggerType: 'event',
          triggerData: { routineId: routine.id, connector: data },
          userMessage:
            `Connector event from ${data.provider}.\n` +
            `Match text: ${data.text ?? '(none)'}\n` +
            `Follow routine "${routine.name}":\n${routine.instructions}`,
          routineRunId: runId,
          skipApprovals: !routine.requireApproval,
        },
        db,
      );
      return { routineId: routine.id, runId };
    }),
  );
  const started = settled.flatMap((outcome) => {
    if (outcome.status === 'fulfilled') return [outcome.value];
    console.error('[weldagent/connectors] routine start failed:', outcome.reason);
    return [];
  });
  return success(c, { matched: matches.length, started });
});

export { app as weldagentParityRoutes };
