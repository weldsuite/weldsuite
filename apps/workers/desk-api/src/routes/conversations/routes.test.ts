/**
 * Every /api/conversations route on pglite, refusals included: list filters
 * and paging, folder counts, detail, the message thread and agent replies,
 * block responses, events, review and audit log, CRUD, and every sub-action.
 * Runs against Rust in conformance mode (rust/conformance/suites.json).
 *
 * Assignments go to the caller (or to nobody), so no notification goes out;
 * replies stay on the chat channel, so nothing is dispatched. The channel
 * paths (Discord, Slack, email) have their own file.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { conversationsRoutes } from './index';

const USER = 'user_test_default';
const ALL = ['conversations:read', 'conversations:create', 'conversations:update', 'conversations:delete'];
let db: Database;

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function app(...keys: string[]) {
  return createTestApp('/api/conversations', conversationsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db },
  });
}

async function seedConversation(
  id: string,
  n: number,
  overrides: Partial<typeof schema.helpdeskConversations.$inferInsert> = {},
) {
  const at = new Date(Date.UTC(2026, 0, 1, 12, 0, n));
  await db.insert(schema.helpdeskConversations).values({
    id,
    conversationNumber: `CONV-${n}`,
    customerName: `Customer ${n}`,
    subject: `Seeded conversation ${n}`,
    status: 'active',
    channel: 'email',
    createdAt: at,
    updatedAt: at,
    ...overrides,
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.people).values([
    { id: 'per_1', displayName: 'Paula', fullName: 'Paula Person', email: 'paula@known.test', avatarUrl: 'https://x/a.png' },
    { id: 'per_2', displayName: 'Known', email: 'known@known.test' },
  ]);
  await seedConversation('conv_a', 1, { contactId: 'per_1', priority: 'high', tags: ['vip'], isRead: false });
  await seedConversation('conv_b', 2, { channel: 'chat', lastCustomerMessageAt: new Date(), assigneeId: USER, isStarred: true });
  await seedConversation('conv_c', 3, { channel: 'chat' });
  await seedConversation('conv_d', 4, { status: 'closed', departmentId: 'dep_1', customerEmail: 'd@x.test', isArchived: true });
  await seedConversation('conv_e', 5, { hasActiveWorkflow: true });
  await seedConversation('conv_f', 6, { assigneeId: 'user_other', customerAvatar: 'https://x/own.png', lastMessage: 'Last words' });
  await seedConversation('conv_gone', 7, { deletedAt: new Date(Date.UTC(2026, 0, 2)) });
  const tie = new Date(Date.UTC(2026, 0, 3));
  await seedConversation('conv_t1', 8, { createdAt: tie, updatedAt: tie, subject: 'Needle subject' });
  await seedConversation('conv_t2', 9, { createdAt: tie, updatedAt: tie, assigneeId: 'ai-agent', channel: 'chat', lastCustomerMessageAt: tie });

  await db.insert(schema.helpdeskConversationMessages).values([
    { id: 'cm_1', conversationId: 'conv_a', authorName: 'Paula', content: 'Hi', authorType: 'customer', createdAt: new Date(Date.UTC(2026, 0, 4, 1)) },
    {
      id: 'cm_2',
      conversationId: 'conv_a',
      authorName: 'Bot',
      content: 'Pick one',
      authorType: 'system',
      blocks: [{ type: 'button_group', actionId: 'pick' }, { type: 'rating', actionId: 'rate' }] as never,
      metadata: { from: 'bot' },
      createdAt: new Date(Date.UTC(2026, 0, 4, 2)),
    },
    { id: 'cm_3', conversationId: 'conv_a', authorName: 'Old', content: 'gone', deletedAt: new Date() },
  ]);
  await db.insert(schema.helpdeskConversationEvents).values([
    { id: 'ce_1', conversationId: 'conv_a', eventType: 'assignment.changed', description: 'Assigned', isPublic: true, createdAt: new Date(Date.UTC(2026, 0, 4, 1)) },
    { id: 'ce_2', conversationId: 'conv_a', eventType: 'status.changed', description: 'Status', isPublic: false, createdAt: new Date(Date.UTC(2026, 0, 4, 2)) },
  ] as never);
  await db.insert(schema.helpdeskReviews).values({
    id: 'rev_1',
    conversationId: 'conv_a',
    rating: 5,
    title: 'Great',
    content: 'Great help',
    reviewerId: 'r',
    reviewerName: 'R',
    reviewerEmail: 'r@x.test',
  });
  await db.insert(schema.auditLogs).values({
    id: 'aud_1',
    entityType: 'helpdesk_conversation',
    entityId: 'conv_a',
    action: 'updated',
    description: 'Updated',
    performedBy: 'user_x',
    createdAt: new Date(Date.UTC(2026, 0, 4)),
  } as never);
  await db.insert(schema.helpdeskDepartments).values([
    { id: 'dep_auto', name: 'Auto', autoAssignment: true },
    { id: 'dep_rr', name: 'Round robin', autoAssignment: true, roundRobinAssignment: true },
    { id: 'dep_manual', name: 'Manual' },
  ]);
  await db.insert(schema.helpdeskAgents).values({
    id: 'agt_me',
    userId: USER,
    name: 'Me Agent',
    email: 'me@x.test',
    departmentId: 'dep_auto',
    teamIds: ['dep_rr'],
    status: 'active',
  });
}, 60_000);

describe('/api/conversations · reads', () => {
  it('lists with the contact laid over, and filters', async () => {
    const { request } = app('conversations:read');
    const res = await request('/api/conversations');
    expect(res.status).toBe(200);
    for (const query of [
      'status=active',
      'excludeStatus=closed',
      'priority=high',
      'channel=chat',
      'departmentId=dep_1',
      'contactId=per_1',
      'customerEmail=d@x.test',
      'unassigned=true',
      'myConversations=true',
      'assigneeId=user_other',
      'isRead=false',
      'isStarred=true',
      'isArchived=true',
      'isRead=maybe',
      'search=Needle',
      'search=paula@known',
      'unassigned=true&assigneeId=user_other',
    ]) {
      expect((await request(`/api/conversations?${query}`)).status).toBe(200);
    }
  });

  it('pages with limit and cursor', async () => {
    const { request } = app('conversations:read');
    const first = (await (await request('/api/conversations?limit=2')).json()) as { pagination: { cursor: string } };
    expect((await request(`/api/conversations?limit=2&cursor=${first.pagination.cursor}`)).status).toBe(200);
    expect((await request('/api/conversations?cursor=nope&status=active')).status).toBe(200);
    for (const limit of ['0', '-1', 'abc']) {
      expect((await request(`/api/conversations?limit=${limit}`)).status).toBe(200);
    }
  });

  it('counts the folders', async () => {
    expect((await app('conversations:read').request('/api/conversations/folder-counts')).status).toBe(200);
  });

  it('answers a conversation, 404 when missing', async () => {
    const { request } = app('conversations:read');
    expect((await request('/api/conversations/conv_a')).status).toBe(200);
    expect((await request('/api/conversations/conv_f')).status).toBe(200);
    expect((await request('/api/conversations/conv_gone')).status).toBe(404);
  });

  it('answers the thread, events, review and audit log', async () => {
    const { request } = app('conversations:read');
    expect((await request('/api/conversations/conv_a/messages')).status).toBe(200);
    expect((await request('/api/conversations/conv_gone/messages')).status).toBe(404);
    for (const query of ['', '?type=assignment.', '?type=status.changed', '?isPublic=true', '?isPublic=false']) {
      expect((await request(`/api/conversations/conv_a/events${query}`)).status).toBe(200);
    }
    expect((await request('/api/conversations/conv_a/review')).status).toBe(200);
    expect((await request('/api/conversations/conv_b/review')).status).toBe(200);
    expect((await request('/api/conversations/conv_a/audit-logs')).status).toBe(200);
  });

  it('needs conversations:read', async () => {
    const { request } = app();
    for (const path of ['', '/folder-counts', '/conv_a', '/conv_a/messages', '/conv_a/events', '/conv_a/review', '/conv_a/audit-logs']) {
      expect((await request(`/api/conversations${path}`)).status).toBe(403);
    }
  });
});

describe('/api/conversations · create, update, delete', () => {
  it('creates, with passthrough columns', async () => {
    const { request } = app('conversations:create');
    const res = await request(
      '/api/conversations',
      json({ subject: 'New thread', customerName: 'Jane', conversationNumber: 'CONV-NEW', assigneeId: USER, priority: 'low' }),
    );
    expect(res.status).toBe(201);
    expect((await request('/api/conversations', json({ subject: 'No number' }))).status).toBe(500);
    expect((await request('/api/conversations', json({ subject: '' }))).status).toBe(400);
    expect((await request('/api/conversations', json({ subject: 'x', customerEmail: 'bad' }))).status).toBe(400);
    expect((await app('conversations:read').request('/api/conversations', json({ subject: 'x' }))).status).toBe(403);
  });

  it('updates, deriving the status fields', async () => {
    const { request } = app('conversations:update');
    expect((await request('/api/conversations/conv_c', json({ subject: 'Renamed', status: 'archived' }, 'PATCH'))).status).toBe(200);
    expect((await request('/api/conversations/conv_c', json({ status: 'active', isArchived: true }, 'PATCH'))).status).toBe(200);
    expect((await request('/api/conversations/conv_c', json({ status: 'snoozed', assigneeId: USER }, 'PATCH'))).status).toBe(200);
    expect((await request('/api/conversations/conv_gone', json({ subject: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await request('/api/conversations/conv_c', json({ subject: '' }, 'PATCH'))).status).toBe(400);
    expect((await app('conversations:read').request('/api/conversations/conv_c', json({}, 'PATCH'))).status).toBe(403);
  });

  it('soft-deletes', async () => {
    const { request } = app('conversations:delete');
    expect((await request('/api/conversations/conv_t1', { method: 'DELETE' })).status).toBe(204);
    expect((await request('/api/conversations/conv_t1', { method: 'DELETE' })).status).toBe(404);
    expect((await app('conversations:update').request('/api/conversations/conv_t2', { method: 'DELETE' })).status).toBe(403);
  });
});

describe('/api/conversations · messages', () => {
  it('replies, claiming an unassigned or AI-parked conversation', async () => {
    const { request } = app('conversations:update');
    const reply = await request('/api/conversations/conv_c/messages', json({ content: 'Hello', authorName: 'Ann' }));
    expect(reply.status).toBe(201);
    const [conv] = await db.select().from(schema.helpdeskConversations).where(eq(schema.helpdeskConversations.id, 'conv_c'));
    expect(conv?.assigneeId).toBe(USER);
    const files = await request(
      '/api/conversations/conv_t2/messages',
      json({
        content: '',
        attachments: [{ id: 'f1', fileName: 'a.pdf', fileSize: 12, mimeType: 'application/pdf', url: 'https://x/a.pdf', extra: 1 }],
        blocks: [{ type: 'button_group', actionId: 'go' }],
      }),
    );
    expect(files.status).toBe(201);
    expect((await request('/api/conversations/conv_b/messages', json({ content: 'note', isInternal: true }))).status).toBe(201);
    expect((await request('/api/conversations/conv_gone/messages', json({ content: 'x' }))).status).toBe(404);
    expect((await request('/api/conversations/conv_b/messages', json({}))).status).toBe(400);
    expect(
      (await request('/api/conversations/conv_b/messages', json({ content: 'x', attachments: [{ id: 'f' }] }))).status,
    ).toBe(400);
    expect((await app('conversations:read').request('/api/conversations/conv_b/messages', json({ content: 'x' }))).status).toBe(403);
  });

  it('records a block response once', async () => {
    const { request } = app('conversations:update');
    const path = '/api/conversations/conv_a/messages/cm_2/respond';
    expect((await request(path, json({ actionId: 'rate', value: 4 }, 'PATCH'))).status).toBe(200);
    expect((await request(path, json({ actionId: 'rate', value: 5 }, 'PATCH'))).status).toBe(400);
    expect((await request(path, json({ actionId: 'nope' }, 'PATCH'))).status).toBe(400);
    expect((await request(path, json({ actionId: 'pick' }, 'PATCH'))).status).toBe(200);
    expect((await request('/api/conversations/conv_a/messages/cm_missing/respond', json({ actionId: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await request(path, json({}, 'PATCH'))).status).toBe(400);
  });
});

describe('/api/conversations · sub-actions', () => {
  it('sets the status and closes', async () => {
    const { request } = app('conversations:update');
    for (const status of ['pending', 'resolved', 'snoozed', 'closed', 'archived', 'active']) {
      expect((await request('/api/conversations/conv_f/status', json({ status }, 'PATCH'))).status).toBe(200);
    }
    expect((await request('/api/conversations/conv_f/status', json({ status: '' }, 'PATCH'))).status).toBe(400);
    expect((await request('/api/conversations/conv_gone/status', json({ status: 'closed' }, 'PATCH'))).status).toBe(404);
    expect((await request('/api/conversations/conv_f/close', { method: 'POST' })).status).toBe(200);
    expect((await request('/api/conversations/conv_gone/close', { method: 'POST' })).status).toBe(404);
  });

  it('marks read, starred, archived and the priority', async () => {
    const { request } = app('conversations:update');
    for (const [path, body] of [
      ['read', { isRead: true }],
      ['read', { isRead: false }],
      ['star', { isStarred: true }],
      ['archive', { isArchived: true }],
      ['archive', { isArchived: false }],
      ['priority', { priority: 'urgent' }],
    ] as const) {
      expect((await request(`/api/conversations/conv_a/${path}`, json(body, 'PATCH'))).status).toBe(200);
      expect((await request(`/api/conversations/conv_gone/${path}`, json(body, 'PATCH'))).status).toBe(404);
    }
    expect((await request('/api/conversations/conv_a/read', json({ isRead: 'yes' }, 'PATCH'))).status).toBe(400);
    expect((await request('/api/conversations/conv_a/priority', json({ priority: '' }, 'PATCH'))).status).toBe(400);
  });

  it('assigns to the caller once, with a joined message', async () => {
    const { request } = app('conversations:update');
    const body = { assigneeId: USER, assigneeName: 'Me', assigneeAvatar: 'https://x/me.png' };
    expect((await request('/api/conversations/conv_d/assign', json(body, 'PATCH'))).status).toBe(200);
    expect((await request('/api/conversations/conv_d/assign', json(body, 'PATCH'))).status).toBe(200);
    expect((await request('/api/conversations/conv_gone/assign', json(body, 'PATCH'))).status).toBe(404);
    expect((await request('/api/conversations/conv_d/assign', json({}, 'PATCH'))).status).toBe(400);
  });

  it('hands a conversation to a team, auto-assigning where the team does', async () => {
    const { request } = app('conversations:update');
    const one = await request('/api/conversations/conv_a/assign-team', json({ departmentId: 'dep_auto' }, 'PATCH'));
    expect(((await one.json()) as { data: { autoAssigned: boolean } }).data.autoAssigned).toBe(true);
    expect((await request('/api/conversations/conv_a/assign-team', json({ departmentId: 'dep_rr' }, 'PATCH'))).status).toBe(200);
    expect((await request('/api/conversations/conv_a/assign-team', json({ departmentId: 'dep_manual' }, 'PATCH'))).status).toBe(200);
    expect(
      (await request('/api/conversations/conv_a/assign-team', json({ departmentId: 'dep_manual', assigneeId: USER, assigneeName: 'Me' }, 'PATCH'))).status,
    ).toBe(200);
    expect((await request('/api/conversations/conv_gone/assign-team', json({ departmentId: 'dep_auto' }, 'PATCH'))).status).toBe(404);
    expect((await request('/api/conversations/conv_a/assign-team', json({}, 'PATCH'))).status).toBe(400);
  });

  it('converts to a ticket, copying the public transcript', async () => {
    const { request } = app('conversations:update');
    expect((await request('/api/conversations/conv_a/convert-to-ticket', json({}))).status).toBe(201);
    expect(
      (await request('/api/conversations/conv_f/convert-to-ticket', json({ subject: 'Escalated', priority: 'high', assigneeId: USER }))).status,
    ).toBe(201);
    expect((await request('/api/conversations/conv_gone/convert-to-ticket', json({}))).status).toBe(404);
    expect((await request('/api/conversations/conv_a/convert-to-ticket', json({ subject: 5 }))).status).toBe(400);
  });

  it('snoozes, tags and links contacts', async () => {
    const { request } = app('conversations:update');
    expect((await request('/api/conversations/conv_b/snooze', json({ snoozedUntil: '2026-12-01T09:00:00.000Z' }, 'PATCH'))).status).toBe(200);
    expect((await request('/api/conversations/conv_b/snooze', json({ snoozedUntil: null, status: 'active' }, 'PATCH'))).status).toBe(200);
    expect((await request('/api/conversations/conv_b/snooze', json({ snoozedUntil: 'not a date' }, 'PATCH'))).status).toBe(500);
    expect((await request('/api/conversations/conv_b/snooze', json({}, 'PATCH'))).status).toBe(400);
    expect((await request('/api/conversations/conv_gone/snooze', json({ snoozedUntil: null }, 'PATCH'))).status).toBe(404);

    for (const body of [
      { tags: ['a', 'b'] },
      { action: 'add', tags: ['b', 'c'] },
      { action: 'remove', tag: 'a' },
      { action: 'remove' },
      {},
    ]) {
      expect((await request('/api/conversations/conv_b/tags', json(body, 'PATCH'))).status).toBe(200);
    }
    expect((await request('/api/conversations/conv_b/tags', json({ action: 'toggle' }, 'PATCH'))).status).toBe(400);
    expect((await request('/api/conversations/conv_gone/tags', json({}, 'PATCH'))).status).toBe(404);

    expect((await request('/api/conversations/conv_b/contact', json({ contactId: 'per_2' }, 'PATCH'))).status).toBe(200);
    expect((await request('/api/conversations/conv_b/contact', json({ contactId: null }, 'PATCH'))).status).toBe(200);
    expect((await request('/api/conversations/conv_b/contact', json({}, 'PATCH'))).status).toBe(400);
    expect((await request('/api/conversations/conv_gone/contact', json({ contactId: null }, 'PATCH'))).status).toBe(404);

    expect((await request('/api/conversations/conv_b/auto-link-contact', json({ email: 'known@known.test' }))).status).toBe(200);
    expect(
      (await request('/api/conversations/conv_c/auto-link-contact', json({ email: 'new.person@x.test', name: 'New Person Here', phone: '+3112' }))).status,
    ).toBe(200);
    expect((await request('/api/conversations/conv_c/auto-link-contact', json({ email: 'solo@x.test' }))).status).toBe(200);
    expect((await request('/api/conversations/conv_c/auto-link-contact', json({ email: 'bad' }))).status).toBe(400);
    expect((await request('/api/conversations/conv_gone/auto-link-contact', json({ email: 'a@x.test' }))).status).toBe(404);
  });

  it('needs conversations:update', async () => {
    const { request } = app(...ALL.filter((k) => k !== 'conversations:update'));
    for (const [method, path] of [
      ['PATCH', 'status'],
      ['POST', 'close'],
      ['PATCH', 'read'],
      ['PATCH', 'star'],
      ['PATCH', 'archive'],
      ['PATCH', 'priority'],
      ['PATCH', 'assign'],
      ['PATCH', 'assign-team'],
      ['POST', 'convert-to-ticket'],
      ['PATCH', 'snooze'],
      ['PATCH', 'tags'],
      ['PATCH', 'contact'],
      ['POST', 'auto-link-contact'],
      ['PATCH', 'messages/cm_2/respond'],
    ] as const) {
      expect((await request(`/api/conversations/conv_a/${path}`, json({}, method))).status).toBe(403);
    }
  });
});
