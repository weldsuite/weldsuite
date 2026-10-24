/**
 * Agents as teammates: owner-controlled access, one main chat per person,
 * and sub-agents (pglite).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { weldagentAgentsRoutes } from './agents';

const MEMBER = permissions('weldagent:read', 'weldagent:use', 'weldagent:create', 'weldagent:update');

describe('weldagent agent access', () => {
  let db: Awaited<ReturnType<typeof createPgliteDb>>['db'];

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 120_000);

  const as = (userId: string, perms = MEMBER) =>
    createTestApp('/api/weldagent/agents', weldagentAgentsRoutes, {
      context: { userId, permissions: perms, tenantDb: db },
    }).request;

  const json = (body: unknown, method = 'POST') => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  async function createAgent(owner: string, name: string): Promise<string> {
    const res = await as(owner)('/api/weldagent/agents', json({ name, systemPrompt: `You are ${name}.` }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; ownerId: string; visibility: string } };
    expect(body.data).toMatchObject({ ownerId: owner, visibility: 'workspace' });
    return body.data.id;
  }

  it('lets the owner decide who can see and use the agent', async () => {
    const id = await createAgent('user_owner', 'Finance Helper');
    const owner = as('user_owner');
    const teammate = as('user_teammate');

    // Workspace-visible by default, but only the owner may change it.
    expect((await teammate(`/api/weldagent/agents/${id}`)).status).toBe(200);
    expect((await teammate(`/api/weldagent/agents/${id}`, json({ name: 'Mine now' }, 'PATCH'))).status).toBe(403);

    expect((await owner(`/api/weldagent/agents/${id}/access`, json({ visibility: 'private' }, 'PUT'))).status).toBe(200);
    expect((await teammate(`/api/weldagent/agents/${id}`)).status).toBe(404);
    const hidden = (await (await teammate('/api/weldagent/agents')).json()) as { data: Array<{ id: string }> };
    expect(hidden.data.some((a) => a.id === id)).toBe(false);
    expect((await teammate(`/api/weldagent/agents/${id}/chat`, json({}))).status).toBe(404);

    const shared = await owner(
      `/api/weldagent/agents/${id}/access`,
      json({ visibility: 'members', memberIds: ['user_teammate'] }, 'PUT'),
    );
    const sharedBody = (await shared.json()) as { data: { memberIds: string[] } };
    expect(sharedBody.data.memberIds).toEqual(['user_teammate']);
    const visible = (await (await teammate('/api/weldagent/agents')).json()) as {
      data: Array<{ id: string; capabilities: { canEdit: boolean } }>;
    };
    expect(visible.data.find((a) => a.id === id)?.capabilities.canEdit).toBe(false);

    // A manager sees and fixes any agent.
    const manager = as('user_admin', permissions('weldagent:read', 'weldagent:update', 'weldagent:manage'));
    expect((await manager(`/api/weldagent/agents/${id}`, json({ name: 'Finance Bot' }, 'PATCH'))).status).toBe(200);

    // Handing the agent over makes the new owner its editor.
    expect((await owner(`/api/weldagent/agents/${id}/access`, json({ ownerId: 'user_teammate' }, 'PUT'))).status).toBe(200);
    expect((await teammate(`/api/weldagent/agents/${id}`, json({ description: 'Mine' }, 'PATCH'))).status).toBe(200);
  });

  it('gives each person one continuous chat per agent', async () => {
    const id = await createAgent('user_owner', 'Support Helper');
    const open = async (userId: string) => {
      const res = await as(userId)(`/api/weldagent/agents/${id}/chat`, json({}));
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { id: string; agentId: string } }).data;
    };
    const first = await open('user_owner');
    expect(first.agentId).toBe(id);
    expect((await open('user_owner')).id).toBe(first.id);
    expect((await open('user_teammate')).id).not.toBe(first.id);
  });

  it('checks the sub-agents an owner picks', async () => {
    const lead = await createAgent('user_owner', 'Lead');
    const researcher = await createAgent('user_owner', 'Researcher');
    const twin = await createAgent('user_other', 'researcher');
    const owner = as('user_owner');

    const self = await owner(
      `/api/weldagent/agents/${lead}/subagents`,
      json({ subagentIds: [lead], delegateToSelf: false }, 'PUT'),
    );
    expect(self.status).toBe(400);

    const clash = await owner(
      `/api/weldagent/agents/${lead}/subagents`,
      json({ subagentIds: [researcher, twin], delegateToSelf: false }, 'PUT'),
    );
    expect(clash.status).toBe(400);

    const ok = await owner(
      `/api/weldagent/agents/${lead}/subagents`,
      json({ subagentIds: [researcher], delegateToSelf: true }, 'PUT'),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { data: { subagentIds: string[]; delegateToSelf: boolean } };
    expect(body.data).toMatchObject({ subagentIds: [researcher], delegateToSelf: true });

    // A private agent of someone else can't be picked.
    await as('user_other')(`/api/weldagent/agents/${twin}/access`, json({ visibility: 'private' }, 'PUT'));
    const hidden = await owner(
      `/api/weldagent/agents/${lead}/subagents`,
      json({ subagentIds: [twin], delegateToSelf: false }, 'PUT'),
    );
    expect(hidden.status).toBe(400);
  });

  it('keeps saving once a picked sub-agent is deleted or out of the owner\'s reach', async () => {
    const lead = await createAgent('user_owner', 'Coordinator');
    const helper = await createAgent('user_owner', 'Helper');
    const theirs = await createAgent('user_other', 'Their Helper');
    const owner = as('user_owner');
    const manager = as('user_admin', permissions('weldagent:read', 'weldagent:update', 'weldagent:delete', 'weldagent:manage'));

    // A manager adds an agent the owner can't see, then the helper is deleted.
    await as('user_other')(`/api/weldagent/agents/${theirs}/access`, json({ visibility: 'private' }, 'PUT'));
    expect(
      (await manager(`/api/weldagent/agents/${lead}/subagents`, json({ subagentIds: [helper, theirs], delegateToSelf: false }, 'PUT')))
        .status,
    ).toBe(200);
    expect((await manager(`/api/weldagent/agents/${helper}`, { method: 'DELETE' })).status).toBe(204);

    // The owner flips "copies of itself" with the stored list unchanged.
    const res = await owner(
      `/api/weldagent/agents/${lead}/subagents`,
      json({ subagentIds: [helper, theirs], delegateToSelf: true }, 'PUT'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { subagentIds: string[]; delegateToSelf: boolean } };
    expect(body.data).toMatchObject({ subagentIds: [theirs], delegateToSelf: true });
  });
});
