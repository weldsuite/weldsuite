/**
 * Workspace AI agents — CRUD + permission gating (pglite).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
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
          'people:read',
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

  it('activating a chat-only agent leaves it manual, and keeps the triggers saved in setup', async () => {
    const { request } = createTestApp('/api/weldagent/agents', weldagentAgentsRoutes, {
      context: {
        permissions: permissions('weldagent:read', 'weldagent:create', 'weldagent:update', 'weldagent:manage'),
        tenantDb: db,
      },
    });
    const create = async (name: string, systemPrompt: string) => {
      const res = await request('/api/weldagent/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, systemPrompt }),
      });
      return ((await res.json()) as { data: { id: string } }).data.id;
    };
    const activate = async (id: string) => {
      const res = await request(`/api/weldagent/agents/${id}/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      return ((await res.json()) as { data: { status: string; eventSubscriptions: string[] } }).data;
    };

    const chatOnly = await create(
      'Chat only',
      'You have no schedules or automatic triggers. Do not create new tasks unless asked. Never open new tickets yourself. When the user asks in chat, create a new person in the CRM.',
    );
    expect(await activate(chatOnly)).toMatchObject({ status: 'active', eventSubscriptions: ['manual'] });

    // Subscriptions the setup saved explicitly survive Activate (the prompt alone would not give them).
    const explicit = await create('Explicit', 'Work through the support ticket queue.');
    const { PLATFORM_TOOLS } = await import('@weldsuite/agent-domain/tools');
    const saveSetup = PLATFORM_TOOLS.find((tool) => tool.id === 'agent.save_setup')!;
    await saveSetup.execute(
      { db, agentId: explicit, actorUserId: 'user_1', workspaceId: 'org_1', actorPermissions: [] },
      { name: 'Queue', systemPrompt: 'Work through the support ticket queue.', triggers: ['ticket.created'] },
    );
    expect(await activate(explicit)).toMatchObject({ status: 'active', eventSubscriptions: ['ticket.created'] });
  });

  it('lists which permission keys give an agent a tool, so the Access tab can tell a grant with none', async () => {
    const { request } = createTestApp('/api/weldagent/agents', weldagentAgentsRoutes, {
      context: { permissions: permissions('weldagent:read', 'weldagent:create', 'weldagent:manage'), tenantDb: db },
    });
    const created = await request('/api/weldagent/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Access test' }),
    });
    const { id } = ((await created.json()) as { data: { id: string } }).data;

    const res = await request(`/api/weldagent/agents/${id}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { toolPermissions: string[] } };
    expect(data.toolPermissions).toEqual(
      expect.arrayContaining([
        'people:read',
        'people:create',
        'tickets:read',
        'tickets:create',
        'tasks:read',
        'tasks:create',
        'projects:read',
        'sheets:read',
        'sheets:update',
        'browser:use',
      ]),
    );
    expect(new Set(data.toolPermissions).size).toBe(data.toolPermissions.length);
    expect(data.toolPermissions).not.toContain('');
  });

  it('refuses to grant an agent permissions the caller lacks', async () => {
    const { request } = createTestApp('/api/weldagent/agents', weldagentAgentsRoutes, {
      context: {
        permissions: permissions('weldagent:read', 'weldagent:create', 'weldagent:update'),
        tenantDb: db,
      },
    });

    const denied = await request('/api/weldagent/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Escalator', permissions: ['people:delete'] }),
    });
    expect(denied.status).toBe(403);

    // No explicit grants: defaults are limited to what the creator holds.
    const created = await request('/api/weldagent/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Plain' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { data: { id: string; permissions: string[] } };
    expect(body.data.permissions).toEqual([]);

    const patched = await request(`/api/weldagent/agents/${body.data.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['tickets:create'] }),
    });
    expect(patched.status).toBe(403);
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
