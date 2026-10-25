/**
 * WeldAgent conversations — agentId on create + complete-turn persistence (pglite).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { weldagentRoutes } from './index';
import {
  acceptConversationTurn,
  completeConversationTurn,
  ConversationNotFoundError,
  loadAcceptedTurn,
  persistAssistantMessage,
  toAcceptedTurnRef,
} from '@weldsuite/agent-domain/complete-turn';
import { schema } from '@weldsuite/worker-kit/db';
import type { Env } from '../../types';

const perms = permissions(
  'weldagent:read',
  'weldagent:create',
  'weldagent:update',
  'weldagent:manage',
  'weldagent:use',
  'agents:read',
);

describe('weldagent conversations', () => {
  let db: Awaited<ReturnType<typeof createPgliteDb>>['db'];

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 120_000);

  function app() {
    return createTestApp('/api/weldagent', weldagentRoutes, {
      context: { permissions: perms, tenantDb: db },
    });
  }

  it('stores agentId on create when the agent exists', async () => {
    const { request } = app();

    const createAgent = await request('/api/weldagent/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Inbox helper',
        systemPrompt: 'List recent people.',
      }),
    });
    expect(createAgent.status).toBe(201);
    const agent = (await createAgent.json()) as { data: { id: string } };

    const missing = await request('/api/weldagent/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nope', agentId: 'agt_missing' }),
    });
    expect(missing.status).toBe(404);

    const createConv = await request('/api/weldagent/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bound chat', agentId: agent.data.id }),
    });
    expect(createConv.status).toBe(201);
    const conv = (await createConv.json()) as { data: { id: string; agentId: string | null } };
    expect(conv.data.agentId).toBe(agent.data.id);

    // Looked up by id, as notification links do.
    const one = await request(`/api/weldagent/conversations/${conv.data.id}`);
    expect(one.status).toBe(200);
    const body = (await one.json()) as { data: { id: string; agentId: string | null } };
    expect(body.data).toMatchObject({ id: conv.data.id, agentId: agent.data.id });

    const gone = await request('/api/weldagent/conversations/conv_missing');
    expect(gone.status).toBe(404);
  });

  it('returns 404 for complete-turn on a missing conversation', async () => {
    const { request } = app();
    const res = await request('/api/weldagent/conversations/conv_missing/complete-turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(res.status).toBe(404);
  });

  it('completeConversationTurn persists the user and assistant messages', async () => {
    const id = `conv_${Date.now().toString(36)}`;
    await db.insert(schema.weldagentConversations).values({
      id,
      userId: 'user_test_default',
      name: 'Turn test',
      messageCount: 0,
    });

    const result = await completeConversationTurn({
      db,
      env: {} as Env,
      workspaceId: 'org_test_default',
      userId: 'user_test_default',
      conversationId: id,
      content: 'What is 2+2?',
      notify: false,
      generate: async () => ({
        text: '4',
        creditsUsed: 1,
        success: true,
      }),
    });

    expect(result.success).toBe(true);
    expect(result.userMessage.content).toBe('What is 2+2?');
    expect(result.assistantMessage?.content).toBe('4');
    expect(result.creditsUsed).toBe(1);

    const rows = await db
      .select()
      .from(schema.weldagentMessages)
      .where(eq(schema.weldagentMessages.conversationId, id));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.role).sort()).toEqual(['assistant', 'user']);

    const [conv] = await db
      .select()
      .from(schema.weldagentConversations)
      .where(eq(schema.weldagentConversations.id, id));
    expect(conv.messageCount).toBe(2);
  });

  it('completeConversationTurn persists a failure reply when generation throws', async () => {
    const id = `conv_fail_${Date.now().toString(36)}`;
    await db.insert(schema.weldagentConversations).values({
      id,
      userId: 'user_test_default',
      name: 'Fail turn test',
      messageCount: 0,
    });

    const result = await completeConversationTurn({
      db,
      env: {} as Env,
      workspaceId: 'org_test_default',
      userId: 'user_test_default',
      conversationId: id,
      content: 'Work & projects',
      notify: false,
      generate: async () => {
        throw new Error('AI gateway is not configured');
      },
    });

    expect(result.success).toBe(false);
    expect(result.pending).toBe(false);
    expect(result.assistantMessage?.content).toContain('could not finish');
    expect(result.assistantMessage?.content).toContain('AI gateway is not configured');

    const rows = await db
      .select()
      .from(schema.weldagentMessages)
      .where(eq(schema.weldagentMessages.conversationId, id));
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.role === 'assistant')).toBe(true);
  });

  it('a reloaded background turn ends with the user message just sent', async () => {
    const id = `conv_reload_${Date.now().toString(36)}`;
    await db.insert(schema.weldagentConversations).values({
      id,
      userId: 'user_test_default',
      name: 'Reload test',
      messageCount: 0,
    });
    const turn = (content: string) =>
      acceptConversationTurn({
        db,
        env: {} as Env,
        workspaceId: 'org_test_default',
        userId: 'user_test_default',
        conversationId: id,
        content,
      });

    // An earlier exchange, then the turn the background job reloads.
    const first = await turn('Which day is it?');
    await persistAssistantMessage({ db, conversationId: id, content: 'Saturday.' });
    const second = await turn('And tomorrow?');
    // Postgres keeps microseconds; a JS Date only milliseconds. Pin them so
    // the reload can't drop the user's own message by rounding.
    const stamps = ['2026-10-24 13:41:01.100111+00', '2026-10-24 13:41:02.200222+00', '2026-10-24 13:41:05.682789+00'];
    const rows = await db
      .select({ id: schema.weldagentMessages.id })
      .from(schema.weldagentMessages)
      .where(eq(schema.weldagentMessages.conversationId, id))
      .orderBy(schema.weldagentMessages.createdAt);
    for (const [i, row] of rows.entries()) {
      await db.execute(sql`update weldagent_messages set created_at = ${stamps[i]}::timestamptz where id = ${row.id}`);
    }

    const loaded = await loadAcceptedTurn(db, toAcceptedTurnRef(second));
    expect(loaded?.chatMessages.map((m) => m.content)).toEqual(['Which day is it?', 'Saturday.', 'And tomorrow?']);
    expect(loaded?.historyOffset).toBe(0);
    expect(first.chatMessages.at(-1)?.content).toBe('Which day is it?');

    // Paging back from the latest message returns exactly the older ones.
    const { request } = app();
    const page = await request(`/api/weldagent/conversations/${id}/messages?before=${second.userMessage.id}`);
    const older = (await page.json()) as { data: Array<{ content: string }> };
    expect(older.data.map((m) => m.content)).toEqual(['Which day is it?', 'Saturday.']);
  });

  it('throws ConversationNotFoundError for a missing thread', async () => {
    await expect(
      completeConversationTurn({
        db,
        env: {} as Env,
        workspaceId: 'org_test_default',
        userId: 'user_test_default',
        conversationId: 'conv_does_not_exist',
        content: 'hi',
        notify: false,
        generate: async () => ({ text: 'x', creditsUsed: 0, success: true }),
      }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it('lists conversations filtered by agentId', async () => {
    const { request } = app();

    const createAgent = await request('/api/weldagent/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'History Bot', systemPrompt: 'Chat helper' }),
    });
    expect(createAgent.status).toBe(201);
    const agent = (await createAgent.json()) as { data: { id: string } };

    await request('/api/weldagent/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bound', agentId: agent.data.id }),
    });
    await request('/api/weldagent/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Unbound' }),
    });

    const filtered = await request(`/api/weldagent/conversations?agentId=${agent.data.id}`);
    expect(filtered.status).toBe(200);
    const body = (await filtered.json()) as {
      data: Array<{ name: string; agentId: string | null }>;
    };
    expect(body.data.every((c) => c.agentId === agent.data.id)).toBe(true);
    expect(body.data.some((c) => c.name === 'Bound')).toBe(true);
    expect(body.data.every((c) => c.name !== 'Unbound')).toBe(true);
  });
});
