/**
 * WeldAgent Grok-parity routes — skills, routines, approvals, memory, templates, teach, connectors.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
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
import { error, success, noContent } from '../../lib/response';
import {
  listSkills,
  getSkill,
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
  completeRoutineRun,
  markRoutineScheduled,
  findConnectorRoutines,
  listApprovals,
  decideApproval,
  listMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  exportAgentTemplate,
  getTemplate,
  getTemplateByShareToken,
  installTemplate,
  startTeachSession,
  appendTeachStep,
  stopTeachSession,
} from '../../services/weldagent/parity';
import { getAgent } from '../../services/weldagent/agents';
import { executeAgentRun } from '../../services/weldagent/run';
import {
  browserAct,
  browserOpen,
  computerListFiles,
  computerStatus,
  isAgentComputerConfigured,
} from '../../services/weldagent/computer-client';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

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
  return success(c, await listAgentSkills(c.get('tenantDb'), c.req.param('id')));
});

app.post('/agents/:id/skills/:skillId', requirePermission('weldagent:update', 'weldagent:manage'), async (c) => {
  const skill = await enableSkillForAgent(c.get('tenantDb'), c.req.param('id'), c.req.param('skillId'));
  if (!skill) return error.notFound(c, 'Skill not found');
  return success(c, skill);
});

app.delete('/agents/:id/skills/:skillId', requirePermission('weldagent:update', 'weldagent:manage'), async (c) => {
  await disableSkillForAgent(c.get('tenantDb'), c.req.param('id'), c.req.param('skillId'));
  return noContent(c);
});

// ----- Routines -----
app.get('/routines', requirePermission('weldagent:read'), async (c) => {
  return success(c, await listRoutines(c.get('tenantDb'), c.req.query('agentId') || undefined));
});

app.post('/routines', requirePermission('weldagent:create', 'weldagent:manage'), zValidator('json', createRoutineSchema), async (c) => {
  const data = c.req.valid('json');
  const agent = await getAgent(c.get('tenantDb'), data.agentId);
  if (!agent) return error.notFound(c, 'Agent not found');
  const routine = await createRoutine(c.get('tenantDb'), { ...data, createdBy: c.get('userId') });
  return success(c, routine, 201);
});

app.patch('/routines/:id', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', updateRoutineSchema), async (c) => {
  const routine = await updateRoutine(c.get('tenantDb'), c.req.param('id'), c.req.valid('json'));
  if (!routine) return error.notFound(c, 'Routine not found');
  return success(c, routine);
});

app.delete('/routines/:id', requirePermission('weldagent:manage', 'weldagent:update'), async (c) => {
  const ok = await deleteRoutine(c.get('tenantDb'), c.req.param('id'));
  if (!ok) return error.notFound(c, 'Routine not found');
  return noContent(c);
});

app.get('/routines/:id/runs', requirePermission('weldagent:read'), async (c) => {
  return success(c, await listRoutineRuns(c.get('tenantDb'), c.req.param('id'), 20));
});

app.post('/routines/:id/test', requirePermission('weldagent:update', 'weldagent:manage'), async (c) => {
  const db = c.get('tenantDb');
  const routine = await getRoutine(db, c.req.param('id'));
  if (!routine) return error.notFound(c, 'Routine not found');
  const runId = await createRoutineRun(db, {
    routineId: routine.id,
    agentId: routine.agentId,
    trigger: 'test',
  });
  try {
    const result = await executeAgentRun({
      db,
      env: c.env,
      workspaceId: c.get('workspaceId'),
      actorUserId: c.get('userId'),
      agentId: routine.agentId,
      triggerType: 'manual',
      triggerData: { routineId: routine.id, test: true },
      userMessage:
        `Run routine "${routine.name}" as a test.\n\n${routine.instructions}` +
        (routine.requireApproval ? '\nRequire approval before consequential actions.' : ''),
      extraSystem: 'This is a routine test run. Prefer draft/recommend over irreversible actions.',
    });
    await completeRoutineRun(db, runId, {
      status: result.success ? 'succeeded' : 'failed',
      summary: result.text,
      error: result.error,
      agentRunId: result.runId,
    });
    return success(c, { runId, ...result });
  } catch (err) {
    await completeRoutineRun(db, runId, {
      status: 'failed',
      error: err instanceof Error ? err.message : 'Routine test failed',
    });
    return error.internal(c, err instanceof Error ? err.message : 'Routine test failed');
  }
});

// ----- Approvals -----
app.get('/approvals', requirePermission('weldagent:read'), async (c) => {
  return success(
    c,
    await listApprovals(c.get('tenantDb'), {
      agentId: c.req.query('agentId') || undefined,
      status: c.req.query('status') || 'pending',
    }),
  );
});

app.post('/approvals/:id/decide', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', decideApprovalSchema), async (c) => {
  const data = c.req.valid('json');
  const approval = await decideApproval(c.get('tenantDb'), c.req.param('id'), {
    decision: data.decision,
    decidedBy: c.get('userId'),
    reason: data.reason,
  });
  if (!approval) return error.notFound(c, 'Approval not found or already decided');
  return success(c, approval);
});

// ----- Memory -----
app.get('/agents/:id/memories', requirePermission('weldagent:read'), async (c) => {
  return success(c, await listMemories(c.get('tenantDb'), c.req.param('id')));
});

app.post('/memories', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', createMemorySchema), async (c) => {
  const data = c.req.valid('json');
  const agent = await getAgent(c.get('tenantDb'), data.agentId);
  if (!agent) return error.notFound(c, 'Agent not found');
  const memory = await createMemory(c.get('tenantDb'), { ...data, createdBy: c.get('userId') });
  return success(c, memory, 201);
});

app.patch('/memories/:id', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', updateMemorySchema), async (c) => {
  const memory = await updateMemory(c.get('tenantDb'), c.req.param('id'), c.req.valid('json'));
  if (!memory) return error.notFound(c, 'Memory not found');
  return success(c, memory);
});

app.delete('/memories/:id', requirePermission('weldagent:update', 'weldagent:manage'), async (c) => {
  await deleteMemory(c.get('tenantDb'), c.req.param('id'));
  return noContent(c);
});

// ----- Templates -----
app.post('/templates/export', requirePermission('weldagent:create', 'weldagent:manage'), zValidator('json', exportTemplateSchema), async (c) => {
  const data = c.req.valid('json');
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
  return success(c, agent, 201);
});

// ----- Teach -----
app.post('/agents/:id/teach/start', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', startTeachSchema), async (c) => {
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
  const session = await appendTeachStep(c.get('tenantDb'), c.req.param('id'), c.req.valid('json').step);
  if (!session) return error.notFound(c, 'Teach session not found or not recording');
  return success(c, session);
});

app.post('/teach/:id/stop', requirePermission('weldagent:update', 'weldagent:manage'), zValidator('json', stopTeachSchema), async (c) => {
  const data = c.req.valid('json');
  const session = await stopTeachSession(c.get('tenantDb'), c.req.param('id'), {
    createSkill: data.createSkill,
    skillName: data.skillName,
    createdBy: c.get('userId'),
  });
  if (!session) return error.notFound(c, 'Teach session not found');
  return success(c, session);
});

// ----- Computer UX helpers -----
app.get('/agents/:id/computer/files', requirePermission('weldagent:read'), async (c) => {
  if (!isAgentComputerConfigured(c.env)) {
    return success(c, { enabled: false, entries: [], reason: 'not_configured' });
  }
  try {
    const path = c.req.query('path') || '/workspace';
    const result = await computerListFiles(c.env, {
      workspaceId: c.get('workspaceId'),
      path,
    });
    return success(c, result);
  } catch (err) {
    return success(c, {
      enabled: false,
      entries: [],
      reason: err instanceof Error ? err.message : 'unavailable',
    });
  }
});

app.post('/agents/:id/browser/live-view', requirePermission('weldagent:read'), async (c) => {
  if (!isAgentComputerConfigured(c.env)) {
    return error.badRequest(c, 'Agent computer is not configured');
  }
  const agentId = c.req.param('id');
  try {
    const result = await browserAct(c.env, {
      workspaceId: c.get('workspaceId'),
      agentId,
      action: 'live_view',
    });
    return success(c, result);
  } catch (err) {
    // No session yet — open a blank page first then request live view.
    try {
      await browserOpen(c.env, {
        workspaceId: c.get('workspaceId'),
        agentId,
        url: 'about:blank',
      });
      const result = await browserAct(c.env, {
        workspaceId: c.get('workspaceId'),
        agentId,
        action: 'live_view',
      });
      return success(c, result);
    } catch (inner) {
      return error.internal(c, inner instanceof Error ? inner.message : 'Live view unavailable');
    }
  }
});

app.get('/computer/health', requirePermission('weldagent:read'), async (c) => {
  if (!isAgentComputerConfigured(c.env)) {
    return success(c, { ok: false, reason: 'not_configured' });
  }
  try {
    const status = await computerStatus(c.env, c.get('workspaceId'));
    return success(c, { ok: true, status });
  } catch (err) {
    return success(c, { ok: false, reason: err instanceof Error ? err.message : 'unavailable' });
  }
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
  const started: Array<{ routineId: string; runId: string }> = [];
  for (const routine of matches.slice(0, 5)) {
    const runId = await createRoutineRun(db, {
      routineId: routine.id,
      agentId: routine.agentId,
      trigger: `connector:${data.provider}`,
    });
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const result = await executeAgentRun({
            db,
            env: c.env,
            workspaceId: c.get('workspaceId'),
            actorUserId: c.get('userId'),
            agentId: routine.agentId,
            triggerType: 'event',
            triggerData: { routineId: routine.id, connector: data },
            userMessage:
              `Connector event from ${data.provider}.\n` +
              `Match text: ${data.text ?? '(none)'}\n` +
              `Follow routine "${routine.name}":\n${routine.instructions}\n` +
              (routine.requireApproval
                ? 'Do not post outbound without approval.'
                : ''),
          });
          await completeRoutineRun(db, runId, {
            status: result.success ? 'succeeded' : 'failed',
            summary: result.text,
            error: result.error,
            agentRunId: result.runId,
          });
          await markRoutineScheduled(db, routine.id);
        } catch (err) {
          await completeRoutineRun(db, runId, {
            status: 'failed',
            error: err instanceof Error ? err.message : 'Connector routine failed',
          });
        }
      })(),
    );
    started.push({ routineId: routine.id, runId });
  }
  return success(c, { matched: matches.length, started });
});

export { app as weldagentParityRoutes };
