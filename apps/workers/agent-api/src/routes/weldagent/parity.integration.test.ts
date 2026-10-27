/**
 * Integration smoke for WeldAgent Grok-parity routes (pglite, built from the
 * real tenant migrations — so a table missing from the migrations fails here).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { weldagentRoutes } from './index';
import { computeNextHourlyRun, toolRiskLevel } from '@weldsuite/agent-domain/parity';

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

  it('keys the routine index on the Clerk org id, not workspaces.id', async () => {
    // The D1 index is read back by the hourly sweep with the org id
    // (docs/plans/workspace-id-standardization.md), so a write under `ws_…` would orphan it.
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const scheduleIndex = {
      prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ sql, args }) }),
      batch: async (batch: Array<{ sql: string; args: unknown[] }>) => {
        statements.push(...batch);
        return [];
      },
    } as unknown as D1Database;
    const { request } = createTestApp('/api/weldagent', weldagentRoutes, {
      context: { permissions: perms, tenantDb: db, workspaceId: 'ws_not_the_org', orgId: 'org_index_test' },
      env: { SCHEDULE_INDEX: scheduleIndex },
    });
    const json = (body: unknown) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const created = await request('/api/weldagent/agents', json({ name: 'Index Bot', systemPrompt: 'When a ticket arrives, triage it.' }));
    const { data: agent } = (await created.json()) as { data: { id: string } };
    const routine = await request(
      '/api/weldagent/routines',
      json({
        agentId: agent.id,
        name: 'Index triage',
        instructions: 'Triage all new tickets.',
        scheduleKind: 'cron',
        cronExpr: '0 8 * * *',
        timezone: 'Europe/Amsterdam',
      }),
    );
    expect(routine.status).toBe(201);

    const cleared = statements.find((s) => s.sql.startsWith('DELETE FROM weldagent_routine_index'));
    expect(cleared?.args).toEqual(['org_index_test', agent.id]);
  });

  it('keeps template export and teaching to the agent\'s owner', async () => {
    const member = permissions('weldagent:read', 'weldagent:use', 'weldagent:create', 'weldagent:update');
    const as = (userId: string) =>
      createTestApp('/api/weldagent', weldagentRoutes, { context: { userId, permissions: member, tenantDb: db } })
        .request;
    const json = (body: unknown) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const created = await as('user_owner')(
      '/api/weldagent/agents',
      json({ name: 'Private Bot', systemPrompt: 'When a ticket arrives, triage it.' }),
    );
    const { data: agent } = (await created.json()) as { data: { id: string } };
    // Workspace-visible by default: the teammate may see the agent, not change it.
    const owner = as('user_owner');
    const teammate = as('user_teammate');
    expect((await teammate(`/api/weldagent/agents/${agent.id}`)).status).toBe(200);

    expect((await teammate('/api/weldagent/templates/export', json({ agentId: agent.id }))).status).toBe(403);
    const exported = await owner('/api/weldagent/templates/export', json({ agentId: agent.id }));
    expect(exported.status).toBe(201);

    const started = await owner(`/api/weldagent/agents/${agent.id}/teach/start`, json({ title: 'Triage a ticket' }));
    expect(started.status).toBe(201);
    const { data: session } = (await started.json()) as { data: { id: string } };

    expect((await teammate(`/api/weldagent/teach/${session.id}/steps`, json({ step: { action: 'click' } }))).status).toBe(403);
    expect((await teammate(`/api/weldagent/teach/${session.id}/stop`, json({ createSkill: true }))).status).toBe(403);
    expect((await owner(`/api/weldagent/teach/${session.id}/steps`, json({ step: { action: 'click' } }))).status).toBe(200);
    expect((await owner(`/api/weldagent/teach/${session.id}/stop`, json({ createSkill: false }))).status).toBe(200);

    // A private agent is invisible to the teammate: not found, not forbidden.
    await owner(`/api/weldagent/agents/${agent.id}/access`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'private' }),
    });
    expect((await teammate('/api/weldagent/templates/export', json({ agentId: agent.id }))).status).toBe(404);
    expect((await teammate(`/api/weldagent/teach/${session.id}/stop`, json({}))).status).toBe(404);
  });

  it('exposes pure helpers', () => {
    expect(toolRiskLevel('create_ticket')).toBe('high');
    expect(computeNextHourlyRun(new Date('2026-01-01T00:30:00Z')).getUTCHours()).toBe(1);
  });
});
