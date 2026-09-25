/**
 * Integration smoke for WeldAgent Grok-parity routes (pglite, built from the
 * real tenant migrations — so a table missing from the migrations fails here).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '../../test/pglite';
import { createTestApp, permissions } from '../../test/harness';
import { weldagentRoutes } from './index';
import { computeNextHourlyRun, toolRiskLevel } from '../../services/weldagent/parity';

const perms = permissions(
  'weldagent:read',
  'weldagent:create',
  'weldagent:update',
  'weldagent:manage',
  'agents:read',
  'computer:use',
  'browser:use',
);

describe('weldagent parity routes', () => {
  let db: Awaited<ReturnType<typeof createPgliteDb>>['db'];

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 120_000);

  function app() {
    return createTestApp('/api/weldagent', weldagentRoutes, {
      context: { permissions: perms, tenantDb: db },
    });
  }

  it('exposes computer health without crashing', async () => {
    const { request } = app();
    const res = await request('/api/weldagent/computer/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { ok: boolean } };
    expect(typeof body.data.ok).toBe('boolean');
  });

  it('creates an agent and a skill', async () => {
    const { request } = app();
    const createAgent = await request('/api/weldagent/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Parity Bot', systemPrompt: 'When chat arrives, help.' }),
    });
    expect(createAgent.status).toBe(201);
    const agent = (await createAgent.json()) as { data: { id: string; permissions: string[] } };
    expect(agent.data.permissions).toEqual(expect.arrayContaining(['computer:use', 'browser:use']));

    const skillRes = await request('/api/weldagent/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Weekly digest',
        instructions: 'Every Monday summarise open tickets and draft a digest. Require approval before sending.',
      }),
    });
    expect(skillRes.status).toBe(201);
  });

  it('loads every Configure section and creates a routine', async () => {
    const { request } = app();
    const created = await request('/api/weldagent/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Configure Bot', systemPrompt: 'When a ticket arrives, triage it.' }),
    });
    const { data: agent } = (await created.json()) as { data: { id: string } };

    // The four calls the Configure tab makes (Approvals, Routines, Skills, Memory).
    for (const path of [
      `/api/weldagent/approvals?agentId=${agent.id}&status=pending`,
      `/api/weldagent/routines?agentId=${agent.id}`,
      `/api/weldagent/agents/${agent.id}/skills`,
      `/api/weldagent/agents/${agent.id}/memories`,
    ]) {
      const res = await request(path);
      expect(res.status, path).toBe(200);
    }

    const routine = await request('/api/weldagent/routines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.id,
        name: 'Morning triage',
        instructions: 'Triage all new tickets from overnight.',
        scheduleKind: 'cron',
        cronExpr: '0 8 * * *',
        timezone: 'Europe/Amsterdam',
      }),
    });
    expect(routine.status).toBe(201);
    const { data: saved } = (await routine.json()) as { data: { nextRunAt: string | null } };
    expect(saved.nextRunAt).not.toBeNull();

    const memory = await request('/api/weldagent/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: agent.id, kind: 'preference', content: 'Reply in Dutch.' }),
    });
    expect(memory.status).toBe(201);
  });

  it('exposes pure helpers', () => {
    expect(toolRiskLevel('create_ticket')).toBe('high');
    expect(computeNextHourlyRun(new Date('2026-01-01T00:30:00Z')).getUTCHours()).toBe(1);
  });
});
