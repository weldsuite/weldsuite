/**
 * /v1/conversations and POST /v1/tickets on the WeldDesk inbox (pglite): what
 * an integration opens lands in `desk_conversations`, where agents work, and
 * an `externalId` keeps repeats of one alert on one conversation.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';
import { schema } from '../db';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.deskMessages);
  await db.delete(schema.deskConversations);
  await db.delete(schema.deskVisitors);
});

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });

interface Conversation {
  id: string;
  channel: string;
  state: string;
  priority: string | null;
  tags: string[];
  title: string | null;
  name: string | null;
  email: string | null;
  externalId: string | null;
  assigneeId: string | null;
}

describe('/v1/conversations · the live inbox', () => {
  const api = () =>
    createExternalTestApp({ scopes: ['conversations:read', 'conversations:write'], tenantDb: db }).request;

  it('opens an alert, then keeps every repeat on it, reopening it after it was closed', async () => {
    const request = api();
    const alert = { externalId: 'datadog:monitor-9', title: 'Disk full on db-1', body: '/var at 98%', name: 'Datadog' };

    const opened = await request('/v1/conversations', post(alert));
    expect(opened.status).toBe(201);
    const first = ((await opened.json()) as { data: Conversation }).data;
    expect(first).toMatchObject({ channel: 'api', state: 'open', externalId: 'datadog:monitor-9', name: 'Datadog' });

    const repeat = await request('/v1/conversations', post({ ...alert, body: '/var at 99%' }));
    expect(repeat.status).toBe(200);
    expect(((await repeat.json()) as { data: Conversation }).data.id).toBe(first.id);

    const closed = await request(`/v1/conversations/${first.id}`, patch({ state: 'closed' }));
    expect(((await closed.json()) as { data: Conversation }).data.state).toBe('closed');

    const back = await request('/v1/conversations', post({ ...alert, body: 'Disk full again' }));
    expect(back.status).toBe(200);
    expect(((await back.json()) as { data: Conversation }).data).toMatchObject({ id: first.id, state: 'open' });

    const listed = await request('/v1/conversations?externalId=datadog:monitor-9');
    const page = (await listed.json()) as { data: Conversation[]; pagination: { totalCount: number } };
    expect(page.pagination.totalCount).toBe(1);

    const timeline = await request(`/v1/conversations/${first.id}/messages`);
    const messages = ((await timeline.json()) as { data: Array<{ kind: string; body: string | null }> }).data;
    expect(messages.filter((m) => m.kind === 'message').map((m) => m.body)).toEqual([
      '/var at 98%',
      '/var at 99%',
      'Disk full again',
    ]);
    expect(messages.filter((m) => m.kind === 'event')).toHaveLength(1);
  });

  it('assigns, notes and replies as the member behind a personal key', async () => {
    const request = api();
    const { data: conversation } = (await (
      await request('/v1/conversations', post({ body: 'Where is my order?', email: 'jo@example.com' }))
    ).json()) as { data: Conversation };

    const assigned = await request(`/v1/conversations/${conversation.id}`, patch({ assigneeId: 'user_ann' }));
    expect(((await assigned.json()) as { data: Conversation }).data.assigneeId).toBe('user_ann');

    const note = await request(`/v1/conversations/${conversation.id}/messages`, post({ body: 'Checked: shipped Monday' }));
    expect(note.status).toBe(201);
    expect(((await note.json()) as { data: { kind: string; authorType: string; authorId: string } }).data).toMatchObject({
      kind: 'note',
      authorType: 'agent',
      authorId: 'user_test',
    });

    const reply = await request(
      `/v1/conversations/${conversation.id}/messages`,
      post({ kind: 'message', body: 'It shipped on Monday' }),
    );
    expect(reply.status).toBe(201);

    const got = await request(`/v1/conversations/${conversation.id}?include=messages`);
    const full = ((await got.json()) as { data: Conversation & { messages: unknown[] } }).data;
    expect(full.messages).toHaveLength(4);
  });

  it('refuses a reply on an email conversation, which only the inbox can send', async () => {
    const request = api();
    const [row] = await db
      .insert(schema.deskConversations)
      .values({ id: 'dconv_email', conversationNumber: 900, channel: 'email', email: 'a@b.c' })
      .returning();

    const res = await request(`/v1/conversations/${row!.id}/messages`, post({ kind: 'message', body: 'Hi' }));
    expect(res.status).toBe(409);
    const note = await request(`/v1/conversations/${row!.id}/messages`, post({ kind: 'note', body: 'Seen' }));
    expect(note.status).toBe(201);
  });

  it('lets a repeat escalate the priority, and sets ticket fields on update', async () => {
    const request = api();
    const alert = { externalId: 'grafana:latency', title: 'p99 latency high', body: 'p99 at 900ms', priority: 'medium' };

    const first = ((await (await request('/v1/conversations', post(alert))).json()) as { data: Conversation }).data;
    expect(first.priority).toBe('medium');

    const worse = await request('/v1/conversations', post({ ...alert, body: 'p99 at 4s', priority: 'urgent' }));
    expect(((await worse.json()) as { data: Conversation }).data).toMatchObject({ id: first.id, priority: 'urgent' });

    const tagged = await request(`/v1/conversations/${first.id}`, patch({ tags: ['latency', 'Latency', 'api'], priority: null }));
    expect(tagged.status).toBe(200);
    expect(((await tagged.json()) as { data: Conversation }).data).toMatchObject({ tags: ['latency', 'api'], priority: null });

    const badType = await request(`/v1/conversations/${first.id}`, patch({ ticketTypeId: 'tt_nope' }));
    expect(badType.status).toBe(400);
  });

  it('filters by search as well as q, so a lookup by name never lists everything', async () => {
    const request = api();
    await request('/v1/conversations', post({ title: 'Disk full on db-1', body: 'a' }));
    await request('/v1/conversations', post({ title: 'Printer jammed', body: 'b' }));

    for (const param of ['search', 'q']) {
      const res = await request(`/v1/conversations?${param}=printer`);
      const page = (await res.json()) as { data: Conversation[] };
      expect(page.data.map((c) => c.title), param).toEqual(['Printer jammed']);
    }
  });

  it('answers 404 for an unknown conversation and 400 for an empty change', async () => {
    const request = api();
    expect((await request('/v1/conversations/dconv_missing', patch({ state: 'closed' }))).status).toBe(404);
    expect((await request('/v1/conversations/dconv_missing/messages')).status).toBe(404);
    expect((await request('/v1/conversations/dconv_missing/messages', post({ body: 'x' }))).status).toBe(404);
    expect((await request('/v1/conversations/dconv_missing', patch({}))).status).toBe(400);
  });

  it('writes as a bot for a workspace key', async () => {
    const { request } = createExternalTestApp({
      tenantDb: db,
      session: {
        keyId: 'key_ws',
        keyType: 'workspace',
        workspaceId: 'ws_test',
        userId: null,
        scopes: ['conversations:read', 'conversations:write'],
        tier: 'enterprise',
        databaseUrl: null,
        licensedApps: null,
      },
    });
    const { data: conversation } = (await (await request('/v1/conversations', post({ body: 'Ping' }))).json()) as {
      data: Conversation;
    };
    const note = await request(`/v1/conversations/${conversation.id}/messages`, post({ body: 'Auto-triaged' }));
    expect(((await note.json()) as { data: { authorType: string; authorId: string } }).data).toMatchObject({
      authorType: 'bot',
      authorId: 'key_ws',
    });
  });
});

describe('POST /v1/tickets · opens an inbox conversation', () => {
  const api = () => createExternalTestApp({ scopes: ['tickets:read', 'tickets:write'], tenantDb: db }).request;

  it('puts the ticket in the inbox, keeps repeats on it and marks the ticket routes deprecated', async () => {
    const request = api();
    const ticket = {
      subject: 'Cannot log in',
      description: 'The reset link has expired',
      customerName: 'Jo Customer',
      customerEmail: 'jo@example.com',
      priority: 'high',
      externalId: 'zendesk:4711',
    };

    const res = await request('/v1/tickets', post(ticket));
    expect(res.status).toBe(201);
    expect(res.headers.get('Deprecation')).toBe('true');
    const conversation = ((await res.json()) as { data: Conversation }).data;
    expect(conversation).toMatchObject({
      channel: 'api',
      title: 'Cannot log in',
      name: 'Jo Customer',
      email: 'jo@example.com',
      externalId: 'zendesk:4711',
      priority: 'high',
    });

    const again = await request('/v1/tickets', post({ ...ticket, description: 'Still cannot log in' }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: Conversation }).data.id).toBe(conversation.id);

    const messages = await db.select().from(schema.deskMessages);
    expect(messages.find((m) => m.kind === 'message')?.metadata).toMatchObject({ via: 'api' });
    expect(messages.some((m) => m.metadata?.eventType === 'attributes_changed')).toBe(true);

    const badTeam = await request('/v1/tickets', post({ ...ticket, externalId: 'zendesk:9', departmentId: 'dep_nope' }));
    expect(badTeam.status).toBe(400);
    expect(await db.select().from(schema.deskConversations)).toHaveLength(1);

    const legacy = await request('/v1/tickets');
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get('Link')).toContain('/v1/conversations');
  });
});
