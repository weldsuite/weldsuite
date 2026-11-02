/**
 * Every /api/helpdesk-weldagent route on pglite: the two /config answers (503,
 * AI is gone), and the conversation record routes: create, the ai-active and
 * ai-resolved pages, pending escalations, the detail with its thread, a
 * message, transfer to a human, accept (which notifies the new assignee) and
 * convert to a ticket, with their refusals. Runs against Rust in conformance
 * mode (rust/conformance/suites.json).
 *
 * These lists order by `updated_at` alone, so every seeded conversation has
 * its own update time.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { helpdeskWeldagentRoutes } from './index';

const BASE = '/api/helpdesk-weldagent';
const USER = 'user_test_default';
let db: Database;

type Row = Record<string, unknown>;
interface PageBody {
  data: {
    conversations: Row[];
    pagination: { page: number | null; pageSize: number | null; totalCount: number; totalPages: number | null };
  };
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const app = (...keys: string[]) =>
  createTestApp(BASE, helpdeskWeldagentRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });

const at = (s: number) => new Date(Date.UTC(2026, 3, 1, 9, 0, s));
const ids = (rows: Row[]) => rows.map((r) => r.id);

async function conversation(
  id: string,
  n: number,
  extra: Partial<typeof schema.helpdeskConversations.$inferInsert> = {},
) {
  await db.insert(schema.helpdeskConversations).values({
    id,
    conversationNumber: `CONV-W${n}`,
    customerName: `Customer ${n}`,
    subject: `Conversation ${n}`,
    assigneeId: 'ai-agent',
    channel: 'chat',
    createdAt: at(n),
    updatedAt: at(n),
    ...extra,
  });
}

async function conversationRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.helpdeskConversations)
    .where(eq(schema.helpdeskConversations.id, id));
  return row!;
}

async function messagesOf(conversationId: string) {
  return db
    .select()
    .from(schema.helpdeskConversationMessages)
    .where(eq(schema.helpdeskConversationMessages.conversationId, conversationId));
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await conversation('wa_1', 1, { status: 'active', subject: 'Billing question', customerEmail: 'ann@x.test' });
  await conversation('wa_2', 2, { status: 'pending', customerName: 'Bob' });
  await conversation('wa_3', 3, {
    status: 'active',
    customerEmail: 'carl@NEEDLE.test',
    lastMessage: 'Need help with my order',
  });
  await conversation('wa_4', 4, { status: 'closed', tags: ['ai-managed'] });
  await conversation('wa_5', 5, { status: 'resolved', tags: ['escalated'] });
  await conversation('wa_6', 6, { status: 'resolved' });
  await conversation('wa_7', 7, { status: 'pending', assigneeId: 'user_h', tags: ['escalated'] });
  await conversation('wa_8', 8, { status: 'pending', tags: ['ai-managed', 'escalated'], customerEmail: 'e@x.test' });
  await conversation('wa_9', 9, { status: 'active', deletedAt: at(20) });
  await conversation('wa_10', 10, { status: 'pending', assigneeId: 'user_h', tags: ['vip'] });
  await conversation('wa_11', 11, { status: 'active', customerEmail: 'f@x.test' });
  await conversation('wa_12', 12, { status: 'active', assigneeId: 'user_h' });
  await db.insert(schema.helpdeskConversationMessages).values([
    { id: 'wm_1', conversationId: 'wa_1', authorName: 'User', content: 'second', createdAt: at(2), updatedAt: at(2) },
    { id: 'wm_2', conversationId: 'wa_1', authorName: 'User', content: 'first', createdAt: at(1), updatedAt: at(1) },
    { id: 'wm_3', conversationId: 'wa_1', authorName: 'User', content: 'gone', createdAt: at(3), deletedAt: at(4) },
  ]);
}, 60_000);

describe(`${BASE} · config`, () => {
  it('GET /config answers 503: AI is unavailable', async () => {
    const res = await app('settings:read').request(`${BASE}/config`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'ai_unavailable', message: 'AI is currently unavailable' } });
    expect((await app().request(`${BASE}/config`)).status).toBe(403);
  });

  it('POST /config validates the body, then answers 503', async () => {
    const { request } = app('settings:update');
    const res = await request(`${BASE}/config`, json({ name: 'Weld', isActive: true, onEscalation: 'notify_only' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'ai_unavailable', message: 'AI is currently unavailable' } });
    expect((await request(`${BASE}/config`, json({}))).status).toBe(503);
    for (const body of [
      { name: 'x'.repeat(51) },
      { logoUrl: 'x'.repeat(501) },
      { onEscalation: 'shout' },
      { onResolution: 'x' },
      { onFailure: 'x' },
      { knowledgePermissions: { a: 'yes' } },
      { enabledBuiltinTools: 'all' },
      { maxIterations: '3' },
    ]) {
      expect((await request(`${BASE}/config`, json(body))).status).toBe(400);
    }
    // The permission is checked before the body.
    expect((await app('settings:read').request(`${BASE}/config`, json({ name: 'x'.repeat(51) }))).status).toBe(403);
  });
});

describe(`${BASE} · reads`, () => {
  it('GET /conversations/ai-active pages the active and pending AI conversations', async () => {
    const { request } = app('conversations:read');
    const res = await request(`${BASE}/conversations/ai-active`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PageBody;
    expect(ids(body.data.conversations)).toEqual(['wa_11', 'wa_8', 'wa_3', 'wa_2', 'wa_1']);
    expect(body.data.pagination).toEqual({ page: 1, pageSize: 25, totalCount: 5, totalPages: 1 });

    const page2 = (await (await request(`${BASE}/conversations/ai-active?page=2&pageSize=2`)).json()) as PageBody;
    expect(ids(page2.data.conversations)).toEqual(['wa_3', 'wa_2']);
    expect(page2.data.pagination).toEqual({ page: 2, pageSize: 2, totalCount: 5, totalPages: 3 });
  });

  it('GET /conversations/ai-active searches subject, name and email, case-insensitively', async () => {
    const { request } = app('conversations:read');
    const bySubject = (await (await request(`${BASE}/conversations/ai-active?search=billing`)).json()) as PageBody;
    expect(ids(bySubject.data.conversations)).toEqual(['wa_1']);
    expect(bySubject.data.pagination.totalCount).toBe(1);
    const byEmail = (await (await request(`${BASE}/conversations/ai-active?search=needle`)).json()) as PageBody;
    expect(ids(byEmail.data.conversations)).toEqual(['wa_3']);
    const byName = (await (await request(`${BASE}/conversations/ai-active?search=BOB`)).json()) as PageBody;
    expect(ids(byName.data.conversations)).toEqual(['wa_2']);
  });

  it('GET /conversations/ai-active with pageSize 0 or 500', async () => {
    const { request } = app('conversations:read');
    const zero = (await (await request(`${BASE}/conversations/ai-active?pageSize=0`)).json()) as PageBody;
    expect(zero.data.conversations).toEqual([]);
    // ceil(5 / 0) is Infinity, which JSON writes as null.
    expect(zero.data.pagination).toEqual({ page: 1, pageSize: 0, totalCount: 5, totalPages: null });
    const big = (await (await request(`${BASE}/conversations/ai-active?pageSize=500`)).json()) as PageBody;
    expect(big.data.pagination.pageSize).toBe(100);
    expect(big.data.conversations).toHaveLength(5);
  });

  it('GET /conversations/ai-active with a page or pageSize that is not a number', async () => {
    const { request } = app('conversations:read');
    const badSize = await request(`${BASE}/conversations/ai-active?pageSize=abc`);
    expect(badSize.status).toBe(200);
    const sizeBody = (await badSize.json()) as PageBody;
    expect(sizeBody.data.conversations).toHaveLength(5);
    expect(sizeBody.data.pagination).toEqual({ page: 1, pageSize: null, totalCount: 5, totalPages: null });
    const badPage = await request(`${BASE}/conversations/ai-active?page=abc&pageSize=2`);
    expect(badPage.status).toBe(200);
    const pageBody = (await badPage.json()) as PageBody;
    expect(ids(pageBody.data.conversations)).toEqual(['wa_11', 'wa_8']);
    expect(pageBody.data.pagination).toEqual({ page: null, pageSize: 2, totalCount: 5, totalPages: 3 });
  });

  it('GET /conversations/ai-active with page 0 asks for a negative offset', async () => {
    const res = await app('conversations:read').request(`${BASE}/conversations/ai-active?page=0`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch active AI conversations' },
    });
  });

  it('GET /conversations/ai-resolved drops escalated rows after paging (the count keeps them)', async () => {
    const { request } = app('conversations:read');
    const res = await request(`${BASE}/conversations/ai-resolved`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PageBody;
    expect(ids(body.data.conversations)).toEqual(['wa_6', 'wa_4']);
    expect(body.data.pagination).toEqual({ page: 1, pageSize: 25, totalCount: 3, totalPages: 1 });
    const second = (await (await request(`${BASE}/conversations/ai-resolved?page=2&pageSize=1`)).json()) as PageBody;
    expect(second.data.conversations).toEqual([]);
    expect(second.data.pagination).toEqual({ page: 2, pageSize: 1, totalCount: 3, totalPages: 3 });
    const searched = (await (await request(`${BASE}/conversations/ai-resolved?search=customer%204`)).json()) as PageBody;
    expect(ids(searched.data.conversations)).toEqual(['wa_4']);
  });

  it('GET /conversations/pending lists escalated pending conversations, whoever holds them', async () => {
    const res = await app('conversations:read').request(`${BASE}/conversations/pending`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Row[] };
    expect(ids(data)).toEqual(['wa_8', 'wa_7']);
  });

  it('GET /conversations/:id answers the row with its live messages, oldest first', async () => {
    const { request } = app('conversations:read');
    const res = await request(`${BASE}/conversations/wa_1`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Row & { messages: Row[] } };
    expect(data.id).toBe('wa_1');
    expect(ids(data.messages)).toEqual(['wm_2', 'wm_1']);
    const human = await request(`${BASE}/conversations/wa_12`);
    expect(((await human.json()) as { data: { messages: Row[] } }).data.messages).toEqual([]);
    expect((await request(`${BASE}/conversations/wa_missing`)).status).toBe(404);
    expect((await request(`${BASE}/conversations/wa_9`)).status).toBe(404);
  });

  it('the reads need conversations:read', async () => {
    const { request } = app('conversations:update');
    for (const path of ['ai-active', 'ai-resolved', 'pending', 'wa_1']) {
      expect((await request(`${BASE}/conversations/${path}`)).status).toBe(403);
    }
  });
});

describe(`${BASE} · create and message`, () => {
  it('POST /conversations creates an AI-managed chat conversation', async () => {
    const res = await app('conversations:create').request(
      `${BASE}/conversations`,
      json({ sessionId: 'sess_1', customerEmail: 'new@x.test', customerName: 'Nina', conversationContext: { page: '/pricing' } }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Row & { id: string } };
    expect(data).toMatchObject({ subject: 'AI Conversation', status: 'active', assigneeId: 'ai-agent' });
    expect(data.conversationNumber).toMatch(/^CONV-[0-9A-Z]+$/);
    const row = await conversationRow(data.id);
    expect(row).toMatchObject({
      customerEmail: 'new@x.test',
      customerName: 'Nina',
      channel: 'chat',
      assigneeName: 'WeldAgent',
      tags: ['ai-managed'],
      isRead: true,
      metadata: { sessionId: 'sess_1', page: '/pricing' },
    });
  });

  it('POST /conversations defaults the visitor, and a context sessionId wins over the body one', async () => {
    const res = await app('conversations:create').request(
      `${BASE}/conversations`,
      json({ sessionId: 'sess_2', conversationContext: { sessionId: 'sess_ctx' } }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const row = await conversationRow(data.id);
    expect(row.customerName).toBe('Visitor');
    expect(row.customerEmail).toBeNull();
    expect(row.metadata).toEqual({ sessionId: 'sess_ctx' });
  });

  it('POST /conversations refuses an invalid body and needs conversations:create', async () => {
    const { request } = app('conversations:create');
    for (const body of [
      {},
      { sessionId: '' },
      { sessionId: 's', customerEmail: 'nope' },
      { sessionId: 's', conversationContext: ['x'] },
    ]) {
      expect((await request(`${BASE}/conversations`, json(body))).status).toBe(400);
    }
    expect((await app('conversations:read').request(`${BASE}/conversations`, json({ sessionId: 's' }))).status).toBe(403);
  });

  it('POST /conversations/:id/messages stores a customer message and bumps the conversation', async () => {
    const content = 'x'.repeat(600);
    const res = await app('conversations:update').request(`${BASE}/conversations/wa_2/messages`, json({ content }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Row };
    expect(data).toMatchObject({ conversationId: 'wa_2', content, role: 'user' });
    const [message] = await messagesOf('wa_2');
    expect(message).toMatchObject({
      authorId: USER,
      authorName: 'User',
      authorType: 'customer',
      type: 'message',
      isRead: false,
    });
    const row = await conversationRow('wa_2');
    expect(row.lastMessage).toHaveLength(500);
    expect(row.preview).toHaveLength(200);
    expect(row.messageCount).toBe(1);
  });

  it('POST /conversations/:id/messages as the assistant, with metadata', async () => {
    const res = await app('conversations:update').request(
      `${BASE}/conversations/wa_11/messages`,
      json({ content: 'Hello!', role: 'assistant', metadata: { model: 'none' } }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: Row }).data.role).toBe('assistant');
    const [message] = await messagesOf('wa_11');
    expect(message).toMatchObject({ authorName: 'WeldAgent', authorType: 'agent', metadata: { model: 'none' } });
  });

  it('POST /conversations/:id/messages refusals', async () => {
    const { request } = app('conversations:update');
    for (const body of [
      {},
      { content: '' },
      { content: 'x'.repeat(10001) },
      { content: 'x', role: 'system' },
      { content: 'x', metadata: 'm' },
    ]) {
      expect((await request(`${BASE}/conversations/wa_2/messages`, json(body))).status).toBe(400);
    }
    expect((await request(`${BASE}/conversations/wa_missing/messages`, json({ content: 'x' }))).status).toBe(404);
    expect((await request(`${BASE}/conversations/wa_9/messages`, json({ content: 'x' }))).status).toBe(404);
    expect(
      (await app('conversations:read').request(`${BASE}/conversations/wa_2/messages`, json({ content: 'x' }))).status,
    ).toBe(403);
  });
});

describe(`${BASE} · escalation`, () => {
  it('POST /:id/transfer-to-human tags the conversation escalated, pending, urgent', async () => {
    const res = await app('conversations:update').request(
      `${BASE}/conversations/wa_1/transfer-to-human`,
      json({ reason: 'Asked for a person', urgency: 'urgent' }),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Row };
    expect(data).toMatchObject({ conversationId: 'wa_1', status: 'pending' });
    const row = await conversationRow('wa_1');
    expect(row).toMatchObject({ status: 'pending', priority: 'urgent', tags: ['escalated'] });
    const system = (await messagesOf('wa_1')).find((m) => m.authorType === 'system');
    expect(system).toMatchObject({
      authorId: 'system',
      authorName: 'System',
      type: 'system',
      content: 'Conversation transferred to human agent. Reason: Asked for a person',
    });
  });

  it('POST /:id/transfer-to-human keeps an existing escalated tag once; other urgencies are high', async () => {
    const res = await app('conversations:update').request(
      `${BASE}/conversations/wa_8/transfer-to-human`,
      json({ reason: '', urgency: 'normal' }),
    );
    expect(res.status).toBe(200);
    const row = await conversationRow('wa_8');
    expect(row).toMatchObject({ priority: 'high', tags: ['ai-managed', 'escalated'] });
  });

  it('POST /:id/transfer-to-human refusals', async () => {
    const { request } = app('conversations:update');
    for (const body of [{}, { reason: 'x'.repeat(1001) }, { reason: 'x', urgency: 1 }]) {
      expect((await request(`${BASE}/conversations/wa_3/transfer-to-human`, json(body))).status).toBe(400);
    }
    expect((await request(`${BASE}/conversations/wa_missing/transfer-to-human`, json({ reason: 'x' }))).status).toBe(404);
    expect(
      (await app('conversations:read').request(`${BASE}/conversations/wa_3/transfer-to-human`, json({ reason: 'x' })))
        .status,
    ).toBe(403);
  });

  it('POST /:id/accept assigns the agent, reopens it, and notifies the agent', async () => {
    const res = await app('conversations:update').request(
      `${BASE}/conversations/wa_8/accept`,
      json({ agentId: 'user_agent_x' }),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Row };
    expect(data).toMatchObject({ conversationId: 'wa_8', assigneeId: 'user_agent_x', status: 'active' });
    const row = await conversationRow('wa_8');
    expect(row).toMatchObject({ assigneeId: 'user_agent_x', status: 'active' });
    await vi.waitFor(async () => {
      const sent = await db
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userId, 'user_agent_x'), eq(schema.notifications.entityId, 'wa_8')));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.title).toBe('Conversation assigned to you');
    });
  });

  it('POST /:id/accept by the caller, or to the same assignee, sends nothing', async () => {
    const { request } = app('conversations:update');
    expect((await request(`${BASE}/conversations/wa_7/accept`, json({ agentId: 'user_h' }))).status).toBe(200);
    expect((await request(`${BASE}/conversations/wa_10/accept`, json({ agentId: USER }))).status).toBe(200);
    expect((await conversationRow('wa_10')).assigneeId).toBe(USER);
  });

  it('POST /:id/accept refusals', async () => {
    const { request } = app('conversations:update');
    for (const body of [{}, { agentId: '' }, { agentId: 3 }]) {
      expect((await request(`${BASE}/conversations/wa_7/accept`, json(body))).status).toBe(400);
    }
    expect((await request(`${BASE}/conversations/wa_missing/accept`, json({ agentId: 'a' }))).status).toBe(404);
    expect(
      (await app('conversations:read').request(`${BASE}/conversations/wa_7/accept`, json({ agentId: 'a' }))).status,
    ).toBe(403);
  });
});

describe(`${BASE} · convert to ticket`, () => {
  it('POST /:id/convert-to-ticket opens a ticket from the conversation and closes it', async () => {
    const res = await app('conversations:update').request(
      `${BASE}/conversations/wa_3/convert-to-ticket`,
      json({ subject: 'Order issue', category: 'orders' }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Row & { ticketId: string } };
    expect(data).toMatchObject({ subject: 'Order issue', status: 'new', priority: 'medium', conversationId: 'wa_3' });
    expect(data.ticketNumber).toMatch(/^TKT-[0-9A-Z]+$/);
    const [ticket] = await db.select().from(schema.helpdeskTickets).where(eq(schema.helpdeskTickets.id, data.ticketId));
    expect(ticket).toMatchObject({
      description: 'Need help with my order',
      category: 'orders',
      channel: 'chat',
      customerEmail: 'carl@NEEDLE.test',
      customerName: 'Customer 3',
      assigneeId: null,
      tags: ['from-ai-conversation'],
      metadata: { sourceConversationId: 'wa_3' },
    });
    // The route's `reporterId` is not a helpdesk_tickets column: Drizzle drops it.
    expect(ticket).not.toHaveProperty('reporterId');
    expect((await conversationRow('wa_3')).status).toBe('closed');
  });

  it('POST /:id/convert-to-ticket with every field', async () => {
    const res = await app('conversations:update').request(
      `${BASE}/conversations/wa_11/convert-to-ticket`,
      json({ subject: 'Escalated', description: 'Written up', priority: 'high', category: 'billing', assigneeId: 'user_h' }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Row & { ticketId: string } };
    expect(data.priority).toBe('high');
    const [ticket] = await db.select().from(schema.helpdeskTickets).where(eq(schema.helpdeskTickets.id, data.ticketId));
    expect(ticket).toMatchObject({ description: 'Written up', priority: 'high', assigneeId: 'user_h' });
  });

  it('POST /:id/convert-to-ticket is the route 500 without a category (a NULL into a NOT NULL column)', async () => {
    const res = await app('conversations:update').request(
      `${BASE}/conversations/wa_12/convert-to-ticket`,
      json({ subject: 'No category' }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to convert conversation to ticket' },
    });
    expect((await conversationRow('wa_12')).status).toBe('active');
  });

  it('POST /:id/convert-to-ticket is the route 500 when the conversation has no customer email', async () => {
    const res = await app('conversations:update').request(
      `${BASE}/conversations/wa_12/convert-to-ticket`,
      json({ subject: 'No email', category: 'general_inquiry' }),
    );
    expect(res.status).toBe(500);
  });

  it('POST /:id/convert-to-ticket refusals', async () => {
    const { request } = app('conversations:update');
    for (const body of [{}, { subject: '' }, { subject: 'x'.repeat(501) }, { subject: 'x', priority: 1 }]) {
      expect((await request(`${BASE}/conversations/wa_4/convert-to-ticket`, json(body))).status).toBe(400);
    }
    expect(
      (await request(`${BASE}/conversations/wa_missing/convert-to-ticket`, json({ subject: 'x' }))).status,
    ).toBe(404);
    expect(
      (await app('conversations:read').request(`${BASE}/conversations/wa_4/convert-to-ticket`, json({ subject: 'x' })))
        .status,
    ).toBe(403);
  });
});
