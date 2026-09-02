/**
 * Workspace AI agents — CRUD + permission gating (pglite).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '../../test/pglite';
import { createTestApp, permissions } from '../../test/harness';
import { weldagentAgentsRoutes } from './agents';

describe('weldagent agents routes', () => {
  let db: Awaited<ReturnType<typeof createPgliteDb>>['db'];

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 120_000);

  it('creates, lists, activates, and pauses an agent', async () => {
    const { request } = createTestApp('/api/weldagent/agents', weldagentAgentsRoutes, {
      context: {
        permissions: permissions(
          'weldagent:read',
          'weldagent:create',
          'weldagent:update',
          'weldagent:manage',
          'weldagent:use',
        ),
        tenantDb: db,
      },
    });

    const createRes = await request('/api/weldagent/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Lead Helper',
        systemPrompt: 'When a new contact is created, list recent people.',
        permissions: ['people:read'],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { data: { id: string; status: string } };
    expect(created.data.status).toBe('draft');
    const id = created.data.id;

    const listRes = await request('/api/weldagent/agents');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: Array<{ id: string }> };
    expect(list.data.some((a) => a.id === id)).toBe(true);

    const activateRes = await request(`/api/weldagent/agents/${id}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(activateRes.status).toBe(200);
    const activated = (await activateRes.json()) as {
      data: { status: string; eventSubscriptions: string[] };
    };
    expect(activated.data.status).toBe('active');
    expect(activated.data.eventSubscriptions).toContain('person.created');

    const pauseRes = await request(`/api/weldagent/agents/${id}/pause`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(pauseRes.status).toBe(200);
    const paused = (await pauseRes.json()) as { data: { status: string } };
    expect(paused.data.status).toBe('paused');
  });

  it('rejects list without weldagent:read', async () => {
    const { request } = createTestApp('/api/weldagent/agents', weldagentAgentsRoutes, {
      context: {
        permissions: permissions('agents:read'),
        tenantDb: db,
      },
    });
    const res = await request('/api/weldagent/agents');
    expect(res.status).toBe(403);
  });

  it('returns tool catalog', async () => {
    const { request } = createTestApp('/api/weldagent/agents', weldagentAgentsRoutes, {
      context: {
        permissions: permissions('weldagent:read'),
        tenantDb: db,
      },
    });
    const res = await request('/api/weldagent/agents/tools');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((t) => t.id === 'people.list')).toBe(true);
    expect(body.data.some((t) => t.id === 'chat.message_agent')).toBe(true);
    expect(body.data.some((t) => t.id === 'chat.create_agent_group')).toBe(true);
  });
});
