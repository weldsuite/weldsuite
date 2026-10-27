/**
 * DB-backed integration tests for /api/desk/conversations and /api/desk/widget.
 *
 * Inbox and chat-widget settings hit these exact paths; a SQL mismatch
 * (missing column, bad ORDER BY) is a 500 in the platform SPA.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { deskConversationsRoutes } from './index';
import { deskWidgetRoutes } from '../desk-widget';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  createDeskConversation,
  ingestDeskEmail,
  rateDeskConversation,
  DeskRatingRejectedError,
} from '@weldsuite/db/lib/desk';
import { generateId } from '@weldsuite/worker-kit/id';
import { eq } from 'drizzle-orm';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/desk/conversations · pglite integration', () => {
  it('GET /?state=open&sort=newest returns 200 against an empty tenant', async () => {
    const { request } = createTestApp('/api/desk/conversations', deskConversationsRoutes, {
      context: { permissions: permissions('conversations:read'), tenantDb: db },
    });

    const res = await request('/api/desk/conversations?state=open&sort=newest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    expect(body.data).toEqual([]);
    expect(body.pagination.totalCount).toBe(0);
    expect(body.pagination.hasMore).toBe(false);
  });

  it('GET / lists a seeded open conversation newest-first', async () => {
    await db.insert(schema.deskVisitors).values({
      id: 'visitor_list_seed',
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSeenAt: new Date(),
      name: 'Ada',
      email: 'ada@example.test',
    });

    const { conversation } = await createDeskConversation(db, {
      generateId,
      visitorId: 'visitor_list_seed',
      name: 'Ada',
      email: 'ada@example.test',
      body: 'Hello from the widget',
    });

    const { request } = createTestApp('/api/desk/conversations', deskConversationsRoutes, {
      context: { permissions: permissions('conversations:read'), tenantDb: db },
    });

    const res = await request('/api/desk/conversations?state=open&sort=newest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; lastMessagePreview: string | null }> };
    expect(body.data.some((row) => row.id === conversation.id)).toBe(true);
    const listed = body.data.find((row) => row.id === conversation.id);
    expect(listed?.lastMessagePreview).toBe('Hello from the widget');
  });
});

describe('ingestDeskEmail · pglite', () => {
  it('creates an email-channel conversation and threads a reply by Message-ID', async () => {
    const first = await ingestDeskEmail(db, {
      generateId,
      fromName: 'Ada',
      fromEmail: 'ada@customer.test',
      toAddress: 'support@acme.test',
      subject: 'Printer is jammed',
      body: 'The lobby printer will not feed paper.',
      rfcMessageId: 'root-msg-1@customer.test',
    });

    expect(first.created).toBe(true);
    expect(first.conversation.channel).toBe('email');
    expect(first.conversation.email).toBe('ada@customer.test');
    expect(first.conversation.title).toBe('Printer is jammed');

    const reply = await ingestDeskEmail(db, {
      generateId,
      fromName: 'Ada',
      fromEmail: 'ada@customer.test',
      toAddress: 'support@acme.test',
      subject: 'Re: Printer is jammed',
      body: 'It is still jammed.',
      rfcMessageId: 'reply-msg-2@customer.test',
      inReplyTo: 'root-msg-1@customer.test',
    });

    expect(reply.created).toBe(false);
    expect(reply.conversation.id).toBe(first.conversation.id);
    expect(reply.message.body).toBe('It is still jammed.');
  });
});

describe('/api/desk/widget · pglite integration', () => {
  it('GET / returns 200 with an empty list (no trailing slash)', async () => {
    const { request } = createTestApp('/api/desk/widget', deskWidgetRoutes, {
      context: { permissions: permissions('settings:read'), tenantDb: db },
    });

    const res = await request('/api/desk/widget');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });
});

describe('/api/desk/conversations search, customer filter and attachments · pglite', () => {
  const R2_PUBLIC_URL = 'https://files.example.test';
  const stored = new Map<string, { size: number; type?: string }>();
  const STORAGE = {
    put: async (key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) => {
      stored.set(key, { size: value.byteLength, type: opts?.httpMetadata?.contentType });
      return {};
    },
  } as unknown as R2Bucket;

  const appFor = (...keys: string[]) =>
    createTestApp('/api/desk/conversations', deskConversationsRoutes, {
      context: { permissions: permissions(...keys), tenantDb: db, clerkOrgId: 'org_search' },
      env: { STORAGE, R2_PUBLIC_URL },
    });

  let printerId: string;
  let printerNumber: number;

  beforeAll(async () => {
    const printer = await createDeskConversation(db, {
      generateId,
      visitorId: 'visitor_search_1',
      name: 'Grace Hopper',
      email: 'Grace@Navy.test',
      body: 'The printer shows error E42',
    });
    printerId = printer.conversation.id;
    printerNumber = printer.conversation.conversationNumber;
    await createDeskConversation(db, {
      generateId,
      visitorId: 'visitor_search_2',
      name: 'Alan',
      email: 'alan@bletchley.test',
      body: 'Question about my invoice',
    });
  });

  const ids = async (res: Response) => ((await res.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id);

  it('finds a conversation by message text, customer name and number', async () => {
    const { request } = appFor('conversations:read');
    for (const q of ['error e42', 'hopper', `#${printerNumber}`]) {
      const res = await request(`/api/desk/conversations?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      const found = await ids(res);
      expect(found).toContain(printerId);
    }
  });

  it('treats % and _ in a search literally', async () => {
    const { request } = appFor('conversations:read');
    const res = await request(`/api/desk/conversations?q=${encodeURIComponent('%')}`);
    expect(await ids(res)).not.toContain(printerId);
  });

  it('lists a customer\'s conversations by email, case-insensitively', async () => {
    const { request } = appFor('conversations:read');
    const res = await request('/api/desk/conversations?email=grace%40navy.test');
    expect(await ids(res)).toEqual([printerId]);
  });

  it('uploads an allowed file and replies with it', async () => {
    const { request } = appFor('conversations:update');
    const form = new FormData();
    form.append('file', new File(['hello'], 'steps to fix.txt', { type: 'text/plain' }));
    const upload = await request(`/api/desk/conversations/${printerId}/attachments`, { method: 'POST', body: form });
    expect(upload.status).toBe(201);
    const attachment = ((await upload.json()) as { data: { url: string; name: string; filesize: number } }).data;
    expect(attachment.url.startsWith(`${R2_PUBLIC_URL}/desk/org_search/${printerId}/`)).toBe(true);
    expect(attachment.name).toBe('steps to fix.txt');
    expect(attachment.filesize).toBe(5);
    expect(stored.size).toBe(1);

    const reply = await request(`/api/desk/conversations/${printerId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'message', attachments: [{ ...attachment, contentType: 'text/plain' }] }),
    });
    expect(reply.status).toBe(201);
    const body = (await reply.json()) as {
      data: { message: { body: string | null; attachments: unknown[] }; conversation: { lastMessagePreview: string } };
    };
    expect(body.data.message.body).toBeNull();
    expect(body.data.message.attachments).toHaveLength(1);
    expect(body.data.conversation.lastMessagePreview).toBe('📎 steps to fix.txt');
  });

  it('rejects script-capable file types', async () => {
    const { request } = appFor('conversations:update');
    const form = new FormData();
    form.append('file', new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }));
    const res = await request(`/api/desk/conversations/${printerId}/attachments`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });

  it('rejects a reply that links a file from somewhere else', async () => {
    const { request } = appFor('conversations:update');
    const res = await request(`/api/desk/conversations/${printerId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'message',
        body: 'see attached',
        attachments: [{ name: 'x.pdf', url: 'https://evil.test/x.pdf', contentType: 'application/pdf', filesize: 1 }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an empty reply', async () => {
    const { request } = appFor('conversations:update');
    const res = await request(`/api/desk/conversations/${printerId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'message', body: '   ' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('CSAT rating · pglite', () => {
  const appFor = (...keys: string[]) =>
    createTestApp('/api/desk/conversations', deskConversationsRoutes, {
      context: { permissions: permissions(...keys), tenantDb: db, userId: 'user_agent_1' },
    });

  const startConversation = async (visitorId: string) =>
    (
      await createDeskConversation(db, {
        generateId,
        visitorId,
        name: 'Rita',
        body: 'Can you help me with my order?',
      })
    ).conversation;

  const close = async (id: string) => {
    const res = await appFor('conversations:update').request(`/api/desk/conversations/${id}/manage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'close' }),
    });
    expect(res.status).toBe(200);
  };

  it('refuses a rating while the conversation is open', async () => {
    const conversation = await startConversation('visitor_rate_open');
    await expect(
      rateDeskConversation(db, { generateId, conversationId: conversation.id, authorId: 'visitor_rate_open', rating: 5 }),
    ).rejects.toMatchObject({ reason: 'not_closed' });
  });

  it('stores a rating on a closed conversation and shows it in the inbox', async () => {
    const conversation = await startConversation('visitor_rate_closed');
    await close(conversation.id);

    const rated = await rateDeskConversation(db, {
      generateId,
      conversationId: conversation.id,
      authorId: 'visitor_rate_closed',
      rating: 4,
      comment: '  Quick answer, thanks  ',
    });
    expect(rated.conversation.rating).toBe(4);
    expect(rated.conversation.ratingComment).toBe('Quick answer, thanks');
    expect(rated.conversation.ratedAt).toBeInstanceOf(Date);
    // Rating doesn't reopen the conversation or put the ball back in the team's court.
    expect(rated.conversation.state).toBe('closed');
    expect(rated.conversation.waitingSince).toBeNull();
    expect(rated.message).toMatchObject({
      kind: 'event',
      authorType: 'visitor',
      authorId: 'visitor_rate_closed',
      metadata: { eventType: 'rated', rating: 4, ratingComment: 'Quick answer, thanks' },
    });

    const res = await appFor('conversations:read').request(
      `/api/desk/conversations/${conversation.id}?include=messages`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        rating: number | null;
        ratingComment: string | null;
        ratedAt: string | null;
        messages: Array<{ kind: string; metadata: { eventType?: string } | null }>;
      };
    };
    expect(body.data.rating).toBe(4);
    expect(body.data.ratingComment).toBe('Quick answer, thanks');
    expect(body.data.ratedAt).not.toBeNull();
    expect(body.data.messages.some((m) => m.kind === 'event' && m.metadata?.eventType === 'rated')).toBe(true);
  });

  it('allows one rating per conversation', async () => {
    const conversation = await startConversation('visitor_rate_twice');
    await close(conversation.id);
    await rateDeskConversation(db, { generateId, conversationId: conversation.id, authorId: 'visitor_rate_twice', rating: 2 });
    const second = rateDeskConversation(db, {
      generateId,
      conversationId: conversation.id,
      authorId: 'visitor_rate_twice',
      rating: 5,
    });
    await expect(second).rejects.toBeInstanceOf(DeskRatingRejectedError);
    await expect(second).rejects.toMatchObject({ reason: 'already_rated' });
    const [row] = await db
      .select({ rating: schema.deskConversations.rating })
      .from(schema.deskConversations)
      .where(eq(schema.deskConversations.id, conversation.id));
    expect(row.rating).toBe(2);
  });

  it('rejects a rating outside 1–5', async () => {
    const conversation = await startConversation('visitor_rate_range');
    await close(conversation.id);
    await expect(
      rateDeskConversation(db, { generateId, conversationId: conversation.id, authorId: null, rating: 6 }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('/api/desk/widget office hours · pglite', () => {
  const appFor = (...keys: string[]) =>
    createTestApp('/api/desk/widget', deskWidgetRoutes, {
      context: { permissions: permissions(...keys), tenantDb: db },
    });

  let widgetId: string;

  beforeAll(async () => {
    const res = await appFor('settings:update').request('/api/desk/widget', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ widgetName: 'Office hours widget' }),
    });
    expect(res.status).toBe(201);
    widgetId = ((await res.json()) as { data: { widgetId: string } }).data.widgetId;
  });

  const patch = (data: Record<string, unknown>) =>
    appFor('settings:update').request(`/api/desk/widget/${widgetId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });

  it('saves the schedule, timezone, away message and reply time', async () => {
    const officeHours = {
      enabled: true,
      days: { mon: { start: '09:00', end: '17:00' }, fri: { start: '09:00', end: '24:00' }, sat: null },
    };
    const res = await patch({
      officeHours,
      timezone: 'Europe/Amsterdam',
      awayMessage: '  We are out — leave your email.  ',
      expectedReplyTime: 'few_hours',
    });
    expect(res.status).toBe(200);

    const get = await appFor('settings:read').request(`/api/desk/widget/${widgetId}`);
    const body = (await get.json()) as {
      data: { officeHours: unknown; timezone: string; awayMessage: string; expectedReplyTime: string };
    };
    expect(body.data.officeHours).toEqual(officeHours);
    expect(body.data.timezone).toBe('Europe/Amsterdam');
    expect(body.data.awayMessage).toBe('We are out — leave your email.');
    expect(body.data.expectedReplyTime).toBe('few_hours');
  });

  it('clears the away message and reply time with null or empty', async () => {
    expect((await patch({ awayMessage: '', expectedReplyTime: null })).status).toBe(200);
    const [row] = await db
      .select()
      .from(schema.deskWidgetSettings)
      .where(eq(schema.deskWidgetSettings.widgetId, widgetId));
    expect(row.awayMessage).toBeNull();
    expect(row.expectedReplyTime).toBeNull();
    expect(row.timezone).toBe('Europe/Amsterdam');
  });

  it.each([
    ['an unknown timezone', { timezone: 'Mars/Olympus' }],
    ['an end before the start', { officeHours: { enabled: true, days: { mon: { start: '17:00', end: '09:00' } } } }],
    ['a malformed time', { officeHours: { enabled: true, days: { mon: { start: '9:00', end: '17:00' } } } }],
    ['an unknown weekday', { officeHours: { enabled: true, days: { funday: { start: '09:00', end: '17:00' } } } }],
    ['an unknown reply time', { expectedReplyTime: 'soon' }],
  ])('rejects %s', async (_label, data) => {
    expect((await patch(data)).status).toBe(400);
  });
});
