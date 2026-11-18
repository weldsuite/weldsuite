/**
 * WeldAgent routes the other integration files leave out: conversation edits,
 * settings, mention search, skills, routines, approvals, memories, template
 * lookups, connector events, grantable permissions and an agent's run history
 * (pglite). Part of the `agent` conformance suite, so Rust must answer alike.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createApproval } from '@weldsuite/agent-domain/parity';
import { weldagentRoutes } from './index';

const FULL = permissions(
  'weldagent:read',
  'weldagent:create',
  'weldagent:update',
  'weldagent:manage',
  'weldagent:use',
  'agents:read',
);
const MEMBER = permissions('weldagent:read', 'weldagent:use', 'weldagent:create', 'weldagent:update');
const READER = permissions('weldagent:read');

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('weldagent routes without other coverage', () => {
  let db: Awaited<ReturnType<typeof createPgliteDb>>['db'];

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 120_000);

  const as = (userId: string, perms = FULL) =>
    createTestApp('/api/weldagent', weldagentRoutes, {
      context: { userId, permissions: perms, tenantDb: db },
      env: { WELDAGENT_JOB: { create: async () => ({ id: 'job' }) } as never },
    }).request;

  async function createAgent(owner: string, name: string): Promise<string> {
    const res = await as(owner)(
      '/api/weldagent/agents',
      json({ name, systemPrompt: 'When a ticket arrives, triage it.' }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  async function createSkill(name: string): Promise<string> {
    const res = await as('user_owner')(
      '/api/weldagent/skills',
      json({ name, instructions: 'Every Monday summarise open tickets and draft a digest.' }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  describe('conversations', () => {
    it('appends a message and counts it', async () => {
      const owner = as('user_owner');
      const created = await owner('/api/weldagent/conversations', json({ name: 'Notes' }));
      const { data: conv } = (await created.json()) as { data: { id: string } };

      const saved = await owner(
        `/api/weldagent/conversations/${conv.id}/messages`,
        json({ role: 'user', content: 'Remember the milk.' }),
      );
      expect(saved.status).toBe(201);
      const { data: message } = (await saved.json()) as { data: { role: string; content: string } };
      expect(message).toMatchObject({ role: 'user', content: 'Remember the milk.' });

      const one = (await (await owner(`/api/weldagent/conversations/${conv.id}`)).json()) as {
        data: { messageCount: number };
      };
      expect(one.data.messageCount).toBe(1);

      const missing = await owner('/api/weldagent/conversations/conv_missing/messages', json({ role: 'user', content: 'hi' }));
      expect(missing.status).toBe(404);
      // Another user's thread is not theirs to write to.
      const foreign = await as('user_other')(
        `/api/weldagent/conversations/${conv.id}/messages`,
        json({ role: 'user', content: 'hi' }),
      );
      expect(foreign.status).toBe(404);
      const invalid = await owner(`/api/weldagent/conversations/${conv.id}/messages`, json({ role: 'robot', content: 'hi' }));
      expect(invalid.status).toBe(400);
    });

    it('renames, pins, auto-titles and deletes', async () => {
      const owner = as('user_owner');
      const created = await owner('/api/weldagent/conversations', json({}));
      const { data: conv } = (await created.json()) as { data: { id: string; name: string } };
      expect(conv.name).toBe('New Conversation');

      const titled = await owner(
        `/api/weldagent/conversations/${conv.id}/auto-title`,
        json({ firstUserMessage: '  What   are my open\n tickets today?  ' }),
      );
      expect(titled.status).toBe(200);
      expect(((await titled.json()) as { data: unknown }).data).toEqual({
        id: conv.id,
        name: 'What are my open tickets today?',
        generated: true,
      });

      // A name that is no longer the placeholder is left alone.
      const again = await owner(`/api/weldagent/conversations/${conv.id}/auto-title`, json({ firstUserMessage: 'Something else' }));
      expect(((await again.json()) as { data: unknown }).data).toEqual({
        id: conv.id,
        name: 'What are my open tickets today?',
        generated: false,
      });
      expect((await owner('/api/weldagent/conversations/conv_missing/auto-title', json({ firstUserMessage: 'x' }))).status).toBe(404);
      expect((await owner(`/api/weldagent/conversations/${conv.id}/auto-title`, json({ firstUserMessage: '' }))).status).toBe(400);

      const patched = await owner(`/api/weldagent/conversations/${conv.id}`, json({ name: 'Renamed', isPinned: true }, 'PATCH'));
      expect(patched.status).toBe(200);
      expect(((await patched.json()) as { data: unknown }).data).toMatchObject({ id: conv.id, name: 'Renamed', isPinned: true });
      expect((await owner('/api/weldagent/conversations/conv_missing', json({ name: 'x' }, 'PATCH'))).status).toBe(404);
      expect((await as('user_other')(`/api/weldagent/conversations/${conv.id}`, json({ name: 'Mine' }, 'PATCH'))).status).toBe(404);

      expect((await owner('/api/weldagent/conversations/conv_missing', { method: 'DELETE' })).status).toBe(404);
      expect((await as('user_other')(`/api/weldagent/conversations/${conv.id}`, { method: 'DELETE' })).status).toBe(404);
      expect((await owner(`/api/weldagent/conversations/${conv.id}`, { method: 'DELETE' })).status).toBe(204);
      expect((await owner(`/api/weldagent/conversations/${conv.id}`)).status).toBe(404);
    });
  });

  describe('settings and mentions', () => {
    it('answers the defaults and echoes an update without storing it', async () => {
      const owner = as('user_owner');
      const got = await owner('/api/weldagent/settings');
      expect(got.status).toBe(200);
      expect(((await got.json()) as { data: unknown }).data).toMatchObject({
        userId: 'user_owner',
        preferredModel: 'openai/gpt-4o',
        temperature: 0.7,
        saveConversationHistory: true,
      });

      const put = await owner('/api/weldagent/settings', json({ temperature: 1.2, customInstructions: 'Be brief.' }, 'PUT'));
      expect(put.status).toBe(200);
      expect(((await put.json()) as { data: unknown }).data).toMatchObject({
        userId: 'user_owner',
        temperature: 1.2,
        customInstructions: 'Be brief.',
        maxTokens: 4096,
      });
      expect(((await (await owner('/api/weldagent/settings')).json()) as { data: { temperature: number } }).data.temperature).toBe(0.7);
      expect((await owner('/api/weldagent/settings', json({ temperature: 9 }, 'PUT'))).status).toBe(400);
    });

    it('returns no mention results', async () => {
      const res = await as('user_owner')('/api/weldagent/mentions/search?q=ann');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: unknown }).data).toEqual([]);
    });
  });

  describe('skills', () => {
    it('lists, updates and deletes a skill, behind permissions', async () => {
      const id = await createSkill('Weekly digest');
      const owner = as('user_owner');

      const list = (await (await owner('/api/weldagent/skills')).json()) as { data: Array<{ id: string }> };
      expect(list.data.some((s) => s.id === id)).toBe(true);
      const archived = (await (await owner('/api/weldagent/skills?status=archived')).json()) as { data: Array<{ id: string }> };
      expect(archived.data.some((s) => s.id === id)).toBe(false);

      const patched = await owner(`/api/weldagent/skills/${id}`, json({ description: 'Digest for Mondays', status: 'archived' }, 'PATCH'));
      expect(patched.status).toBe(200);
      expect(((await patched.json()) as { data: unknown }).data).toMatchObject({ id, description: 'Digest for Mondays', status: 'archived' });
      expect((await owner('/api/weldagent/skills/skl_missing', json({ description: 'x' }, 'PATCH'))).status).toBe(404);

      // Reading is not changing.
      const reader = as('user_reader', READER);
      expect((await reader('/api/weldagent/skills')).status).toBe(200);
      expect((await reader(`/api/weldagent/skills/${id}`, json({ description: 'x' }, 'PATCH'))).status).toBe(403);
      expect((await reader(`/api/weldagent/skills/${id}`, { method: 'DELETE' })).status).toBe(403);

      expect((await owner(`/api/weldagent/skills/${id}`, { method: 'DELETE' })).status).toBe(204);
      expect((await owner(`/api/weldagent/skills/${id}`, { method: 'DELETE' })).status).toBe(404);
    });

    it('turns a skill on and off for an agent, for its owner only', async () => {
      const agentId = await createAgent('user_owner', 'Digest Bot');
      const skillId = await createSkill('Ticket digest');
      const owner = as('user_owner');
      const teammate = as('user_teammate', MEMBER);

      const enabled = await owner(`/api/weldagent/agents/${agentId}/skills/${skillId}`, json({}));
      expect(enabled.status).toBe(200);
      const listed = (await (await owner(`/api/weldagent/agents/${agentId}/skills`)).json()) as { data: Array<{ id: string }> };
      expect(listed.data.map((s) => s.id)).toContain(skillId);

      expect((await owner(`/api/weldagent/agents/${agentId}/skills/skl_missing`, json({}))).status).toBe(404);
      expect((await owner(`/api/weldagent/agents/agt_missing/skills/${skillId}`, json({}))).status).toBe(404);
      // Workspace-visible, so the teammate sees the agent but may not change it.
      expect((await teammate(`/api/weldagent/agents/${agentId}/skills/${skillId}`, json({}))).status).toBe(403);
      expect((await teammate(`/api/weldagent/agents/${agentId}/skills/${skillId}`, { method: 'DELETE' })).status).toBe(403);
      expect((await as('user_reader', READER)(`/api/weldagent/agents/${agentId}/skills/${skillId}`, { method: 'DELETE' })).status).toBe(403);

      expect((await owner(`/api/weldagent/agents/${agentId}/skills/${skillId}`, { method: 'DELETE' })).status).toBe(204);
      const after = (await (await owner(`/api/weldagent/agents/${agentId}/skills`)).json()) as {
        data: Array<{ id: string; enabled: boolean }>;
      };
      expect(after.data.find((s) => s.id === skillId)?.enabled).toBe(false);
      expect((await owner(`/api/weldagent/agents/agt_missing/skills/${skillId}`, { method: 'DELETE' })).status).toBe(404);
    });
  });

  describe('routines', () => {
    async function createRoutine(agentId: string): Promise<string> {
      const res = await as('user_owner')(
        '/api/weldagent/routines',
        json({
          agentId,
          name: 'Morning triage',
          instructions: 'Triage all new tickets from overnight.',
          scheduleKind: 'cron',
          cronExpr: '0 8 * * *',
          timezone: 'Europe/Amsterdam',
        }),
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { data: { id: string } }).data.id;
    }

    it('updates, lists runs of, tests and deletes a routine', async () => {
      const agentId = await createAgent('user_owner', 'Routine Bot');
      const id = await createRoutine(agentId);
      const owner = as('user_owner');
      const teammate = as('user_teammate', MEMBER);

      const patched = await owner(`/api/weldagent/routines/${id}`, json({ name: 'Evening triage', cronExpr: '0 18 * * *' }, 'PATCH'));
      expect(patched.status).toBe(200);
      expect(((await patched.json()) as { data: unknown }).data).toMatchObject({ id, name: 'Evening triage', cronExpr: '0 18 * * *' });
      expect((await owner('/api/weldagent/routines/rtn_missing', json({ name: 'Nope' }, 'PATCH'))).status).toBe(404);
      expect((await teammate(`/api/weldagent/routines/${id}`, json({ name: 'Mine' }, 'PATCH'))).status).toBe(403);
      expect((await as('user_reader', READER)(`/api/weldagent/routines/${id}`, json({ name: 'Mine' }, 'PATCH'))).status).toBe(403);

      const noRuns = await owner(`/api/weldagent/routines/${id}/runs`);
      expect(noRuns.status).toBe(200);
      expect(((await noRuns.json()) as { data: unknown[] }).data).toEqual([]);
      expect((await owner('/api/weldagent/routines/rtn_missing/runs')).status).toBe(404);

      expect((await owner('/api/weldagent/routines/rtn_missing/test', json({}))).status).toBe(404);
      expect((await teammate(`/api/weldagent/routines/${id}/test`, json({}))).status).toBe(403);
      const tested = await owner(`/api/weldagent/routines/${id}/test`, json({}));
      expect(tested.status).toBe(200);
      const { data: queued } = (await tested.json()) as { data: { queued: boolean; runId: string } };
      expect(queued.queued).toBe(true);
      const runs = (await (await owner(`/api/weldagent/routines/${id}/runs`)).json()) as {
        data: Array<{ id: string; trigger: string }>;
      };
      expect(runs.data).toEqual([expect.objectContaining({ id: queued.runId, trigger: 'test' })]);

      expect((await owner('/api/weldagent/routines/rtn_missing', { method: 'DELETE' })).status).toBe(404);
      expect((await teammate(`/api/weldagent/routines/${id}`, { method: 'DELETE' })).status).toBe(403);
      expect((await owner(`/api/weldagent/routines/${id}`, { method: 'DELETE' })).status).toBe(204);
      expect((await owner(`/api/weldagent/routines/${id}`, { method: 'DELETE' })).status).toBe(404);
    });
  });

  describe('approvals', () => {
    it('rejects, refuses and 404s', async () => {
      const agentId = await createAgent('user_owner', 'Approval Bot');
      const owner = as('user_owner');
      const asker = as('user_asker', permissions('weldagent:use'));
      const stranger = as('user_stranger', permissions('weldagent:use'));

      const pending = await createApproval(db, {
        agentId,
        toolName: 'create_ticket',
        args: { subject: 'Printer' },
        createdBy: 'user_asker',
      });
      // Neither the agent's owner nor whoever asked: not theirs to decide.
      expect((await stranger(`/api/weldagent/approvals/${pending.id}/decide`, json({ decision: 'rejected' }))).status).toBe(403);
      expect((await owner('/api/weldagent/approvals/apr_missing/decide', json({ decision: 'rejected' }))).status).toBe(404);
      expect((await owner(`/api/weldagent/approvals/${pending.id}/decide`, json({ decision: 'maybe' }))).status).toBe(400);
      expect((await as('user_reader', READER)(`/api/weldagent/approvals/${pending.id}/decide`, json({ decision: 'rejected' }))).status).toBe(403);

      // The person who asked may decline their own request.
      const declined = await asker(`/api/weldagent/approvals/${pending.id}/decide`, json({ decision: 'rejected', reason: 'Not needed' }));
      expect(declined.status).toBe(200);
      expect(((await declined.json()) as { data: unknown }).data).toMatchObject({
        id: pending.id,
        status: 'rejected',
        decidedBy: 'user_asker',
        reason: 'Not needed',
        execution: { ran: false, ok: true },
      });
      // Decided once only.
      expect((await owner(`/api/weldagent/approvals/${pending.id}/decide`, json({ decision: 'rejected' }))).status).toBe(404);
    });

    it('answers an approval whose tool is no longer there', async () => {
      const agentId = await createAgent('user_owner', 'Gone Tool Bot');
      const approval = await createApproval(db, {
        agentId,
        toolName: 'no_such_tool',
        args: {},
        createdBy: 'user_owner',
      });
      const res = await as('user_owner')(`/api/weldagent/approvals/${approval.id}/decide`, json({ decision: 'approved' }));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: unknown }).data).toMatchObject({
        id: approval.id,
        status: 'approved',
        execution: {
          ran: false,
          ok: false,
          error: 'This action is no longer available to this agent, or you lack the permission it needs.',
        },
      });
    });
  });

  describe('memories', () => {
    it("edits and removes a memory, for the agent's owner", async () => {
      const agentId = await createAgent('user_owner', 'Memory Bot');
      const owner = as('user_owner');
      const teammate = as('user_teammate', MEMBER);
      const created = await owner('/api/weldagent/memories', json({ agentId, kind: 'preference', content: 'Reply in Dutch.' }));
      expect(created.status).toBe(201);
      const { data: memory } = (await created.json()) as { data: { id: string } };

      const patched = await owner(`/api/weldagent/memories/${memory.id}`, json({ content: 'Reply in English.', kind: 'correction' }, 'PATCH'));
      expect(patched.status).toBe(200);
      expect(((await patched.json()) as { data: unknown }).data).toMatchObject({
        id: memory.id,
        content: 'Reply in English.',
        kind: 'correction',
      });
      expect((await owner('/api/weldagent/memories/mem_missing', json({ content: 'x' }, 'PATCH'))).status).toBe(404);
      expect((await teammate(`/api/weldagent/memories/${memory.id}`, json({ content: 'Mine' }, 'PATCH'))).status).toBe(403);
      expect((await teammate(`/api/weldagent/memories/${memory.id}`, { method: 'DELETE' })).status).toBe(403);
      expect((await as('user_reader', READER)(`/api/weldagent/memories/${memory.id}`, { method: 'DELETE' })).status).toBe(403);

      expect((await owner(`/api/weldagent/memories/${memory.id}`, { method: 'DELETE' })).status).toBe(204);
      // Deleting what is gone is not an error.
      expect((await owner(`/api/weldagent/memories/${memory.id}`, { method: 'DELETE' })).status).toBe(204);
      const left = (await (await owner(`/api/weldagent/agents/${agentId}/memories`)).json()) as { data: unknown[] };
      expect(left.data).toEqual([]);
    });
  });

  describe('templates', () => {
    it('looks a template up by id and by share token', async () => {
      const agentId = await createAgent('user_owner', 'Template Bot');
      const exported = await as('user_owner')('/api/weldagent/templates/export', json({ agentId, name: 'Triage template' }));
      expect(exported.status).toBe(201);
      const { data: template } = (await exported.json()) as { data: { id: string; shareToken: string } };

      const byId = await as('user_teammate', MEMBER)(`/api/weldagent/templates/${template.id}`);
      expect(byId.status).toBe(200);
      expect(((await byId.json()) as { data: unknown }).data).toMatchObject({ id: template.id, name: 'Triage template' });

      const byToken = await as('user_teammate', MEMBER)(`/api/weldagent/templates/share/${template.shareToken}`);
      expect(byToken.status).toBe(200);
      expect(((await byToken.json()) as { data: unknown }).data).toMatchObject({ id: template.id });

      expect((await as('user_owner')('/api/weldagent/templates/tpl_missing')).status).toBe(404);
      expect((await as('user_owner')('/api/weldagent/templates/share/share_missing')).status).toBe(404);
      expect((await as('user_none', permissions())(`/api/weldagent/templates/${template.id}`)).status).toBe(403);
    });
  });

  describe('connector events', () => {
    it('matches no routine, and needs the right permission', async () => {
      const owner = as('user_owner');
      const none = await owner('/api/weldagent/connectors/events', json({ provider: 'slack', channel: 'C1', text: 'deploy failed' }));
      expect(none.status).toBe(200);
      expect(((await none.json()) as { data: unknown }).data).toEqual({ matched: 0, started: [] });

      // A connector routine for another repo does not match this event.
      const agentId = await createAgent('user_owner', 'Connector Bot');
      const routine = await owner(
        '/api/weldagent/routines',
        json({
          agentId,
          name: 'Watch the other repo',
          instructions: 'Summarise every new issue.',
          scheduleKind: 'connector',
          connectorConfig: { provider: 'github', repo: 'weldsuite/other', event: 'issues' },
        }),
      );
      expect(routine.status).toBe(201);
      const other = await owner('/api/weldagent/connectors/events', json({ provider: 'github', repo: 'weldsuite/weldsuite', event: 'issues' }));
      expect(((await other.json()) as { data: unknown }).data).toEqual({ matched: 0, started: [] });

      expect((await owner('/api/weldagent/connectors/events', json({ provider: 'email' }))).status).toBe(400);
      expect((await as('user_reader', READER)('/api/weldagent/connectors/events', json({ provider: 'slack' }))).status).toBe(403);
    });
  });

  describe('agents', () => {
    it('lists the permissions an agent can be given', async () => {
      const res = await as('user_owner')('/api/weldagent/agents/grantable-permissions');
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: unknown[] };
      expect(data.length).toBeGreaterThan(0);
      expect((await as('user_none', permissions())('/api/weldagent/agents/grantable-permissions')).status).toBe(403);
    });

    it("lists an agent's runs", async () => {
      const agentId = await createAgent('user_owner', 'History Bot');
      const owner = as('user_owner');
      const empty = await owner(`/api/weldagent/agents/${agentId}/runs`);
      expect(empty.status).toBe(200);
      expect(((await empty.json()) as { data: unknown[] }).data).toEqual([]);

      expect((await owner('/api/weldagent/agents/agt_missing/runs')).status).toBe(404);
      expect((await owner(`/api/weldagent/agents/${agentId}/runs?limit=1`)).status).toBe(200);
      expect((await as('user_none', permissions())(`/api/weldagent/agents/${agentId}/runs`)).status).toBe(403);
    });
  });
});
