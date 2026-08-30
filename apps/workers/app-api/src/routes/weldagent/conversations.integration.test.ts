/**
 * WeldAgent conversations — agentId on create + complete-turn persistence (pglite).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '../../test/pglite';
import { createTestApp, permissions } from '../../test/harness';
import { weldagentRoutes } from './index';
import {
  completeConversationTurn,
  ConversationNotFoundError,
} from '../../services/weldagent/complete-turn';
import { schema } from '../../db';
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
    expect(result.assistantMessage.content).toBe('4');
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
});
