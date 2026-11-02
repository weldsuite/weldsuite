/**
 * /api/meeting-messages against a real schema (pglite): the in-meeting chat
 * (list, pinned, send, pin/unpin, delete-own) and the generic CRUD rows.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { meetingMessagesRoutes } from './index';
import { fakeRealtime } from '../../test/fakes';
import type { Env, Variables } from '../../types';

const ME = 'user_test_default';
const OTHER = 'user_other_author';

let db: Database;
let realtime = fakeRealtime();
let events: Array<{ entityType: string; action: string; entityId: string; data: Record<string, unknown> }> = [];

const eventsBinding = {
  send: async (message: (typeof events)[number]) => {
    events.push(message);
  },
  sendBatch: async (messages: Array<{ body: (typeof events)[number] }>) => {
    for (const message of messages) events.push(message.body);
  },
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values({
    id: 'wm_msg_me',
    userId: ME,
    email: 'me@example.com',
    name: 'Mia Messenger',
    picture: 'https://cdn.example.com/mia.png',
  });
  await db.insert(schema.meetings).values([
    { id: 'mtg_chat_a', title: 'Chat A', organizerId: ME, status: 'in_progress' },
    { id: 'mtg_chat_b', title: 'Chat B', organizerId: ME, status: 'scheduled' },
  ]);
  const at = (minute: number) => new Date(Date.UTC(2026, 5, 1, 9, minute));
  await db.insert(schema.meetingMessages).values([
    { id: 'mmsg_a1', meetingId: 'mtg_chat_a', authorId: ME, authorName: 'Mia', content: 'first', createdAt: at(1), updatedAt: at(1) },
    {
      id: 'mmsg_a2',
      meetingId: 'mtg_chat_a',
      authorId: OTHER,
      authorName: 'Otto',
      content: 'second',
      metadata: { htmlContent: '<p>second</p>' },
      createdAt: at(2),
      updatedAt: at(2),
    },
    { id: 'mmsg_a3', meetingId: 'mtg_chat_a', authorId: ME, authorName: 'Mia', content: 'third', createdAt: at(3), updatedAt: at(3) },
    {
      id: 'mmsg_a4',
      meetingId: 'mtg_chat_a',
      authorId: OTHER,
      authorName: 'Otto',
      content: 'gone',
      deletedAt: at(5),
      createdAt: at(4),
      updatedAt: at(5),
    },
    { id: 'mmsg_b1', meetingId: 'mtg_chat_b', authorId: OTHER, authorName: 'Otto', content: 'elsewhere', createdAt: at(6), updatedAt: at(6) },
  ]);
}, 60_000);

beforeEach(() => {
  realtime = fakeRealtime();
  events = [];
});

function app(perms: string[] = ['meetings:read', 'meetings:update', 'meetings:delete', 'sessions:create']) {
  return createTestApp<Env, Variables>('/api/meeting-messages', meetingMessagesRoutes, {
    context: { permissions: permissions(...perms), userId: ME, tenantDb: db },
    env: { REALTIME: realtime.binding, ENTITY_EVENTS: eventsBinding } as unknown as Partial<Env>,
  });
}

const json = { 'Content-Type': 'application/json' };
type Listed = { data: Array<{ id: string }>; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
type Chat = { data: { messages: Array<{ id: string; htmlContent: string | null }>; hasMore: boolean; nextCursor: string | null } };

describe('GET /api/meeting-messages', () => {
  it('lists every live message newest first, by author, with a cursor', async () => {
    const { request } = app();
    const all = (await (await request('/api/meeting-messages')).json()) as Listed;
    expect(all.data.map((m) => m.id)).toEqual(['mmsg_b1', 'mmsg_a3', 'mmsg_a2', 'mmsg_a1']);
    expect(all.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });

    const mine = (await (await request(`/api/meeting-messages?authorId=${ME}`)).json()) as Listed;
    expect(mine.data.map((m) => m.id)).toEqual(['mmsg_a3', 'mmsg_a1']);

    const first = (await (await request('/api/meeting-messages?limit=2')).json()) as Listed;
    expect(first.data.map((m) => m.id)).toEqual(['mmsg_b1', 'mmsg_a3']);
    expect(first.pagination).toEqual({ totalCount: 4, hasMore: true, cursor: 'mmsg_a3' });
    const next = (await (await request('/api/meeting-messages?limit=2&cursor=mmsg_a3')).json()) as Listed;
    expect(next.data.map((m) => m.id)).toEqual(['mmsg_a2', 'mmsg_a1']);
    expect(next.pagination).toMatchObject({ totalCount: 4, hasMore: false });

    // An unknown cursor is ignored.
    expect(((await (await request('/api/meeting-messages?cursor=mmsg_nope')).json()) as Listed).data).toHaveLength(4);
  });

  it("lists one meeting's chat with its HTML and a `before` cursor", async () => {
    const { request } = app();
    const chat = (await (await request('/api/meeting-messages?meetingId=mtg_chat_a')).json()) as Chat;
    expect(chat.data.messages.map((m) => m.id)).toEqual(['mmsg_a3', 'mmsg_a2', 'mmsg_a1']);
    expect(chat.data.messages.find((m) => m.id === 'mmsg_a2')?.htmlContent).toBe('<p>second</p>');
    expect(chat.data.messages.find((m) => m.id === 'mmsg_a1')?.htmlContent).toBeNull();
    expect(chat.data).toMatchObject({ hasMore: false, nextCursor: null });

    const page = (await (await request('/api/meeting-messages?meetingId=mtg_chat_a&limit=1')).json()) as Chat;
    expect(page.data).toMatchObject({ hasMore: true, nextCursor: 'mmsg_a3' });
    const older = (await (await request('/api/meeting-messages?meetingId=mtg_chat_a&before=mmsg_a3')).json()) as Chat;
    expect(older.data.messages.map((m) => m.id)).toEqual(['mmsg_a2', 'mmsg_a1']);
  });

  it('needs meetings:read', async () => {
    expect((await app(['sessions:create']).request('/api/meeting-messages')).status).toBe(403);
  });
});

describe('pinned messages', () => {
  it('pins, lists pinned, unpins', async () => {
    const { request } = app();
    expect((await request('/api/meeting-messages/pinned')).status).toBe(400);

    const pin = await request('/api/meeting-messages/mmsg_a2/pin?meetingId=mtg_chat_a', { method: 'POST' });
    expect(pin.status).toBe(200);
    expect(await pin.json()).toEqual({ data: { pinned: true } });
    const [row] = await db.select().from(schema.meetingMessages).where(eq(schema.meetingMessages.id, 'mmsg_a2'));
    expect(row).toMatchObject({ pinnedBy: ME });
    expect(row?.pinnedAt).toBeTruthy();

    const pinned = (await (await request('/api/meeting-messages/pinned?meetingId=mtg_chat_a')).json()) as {
      data: { messages: Array<{ id: string }> };
    };
    expect(pinned.data.messages.map((m) => m.id)).toEqual(['mmsg_a2']);

    // A message of another meeting, a deleted one and an unknown one are 404s.
    expect((await request('/api/meeting-messages/mmsg_a2/pin?meetingId=mtg_chat_b', { method: 'POST' })).status).toBe(404);
    expect((await request('/api/meeting-messages/mmsg_a4/pin', { method: 'POST' })).status).toBe(404);
    expect((await request('/api/meeting-messages/mmsg_nope/pin', { method: 'POST' })).status).toBe(404);

    const unpin = await request('/api/meeting-messages/mmsg_a2/pin?meetingId=mtg_chat_a', { method: 'DELETE' });
    expect(await unpin.json()).toEqual({ data: { pinned: false } });
    const [after] = await db.select().from(schema.meetingMessages).where(eq(schema.meetingMessages.id, 'mmsg_a2'));
    expect(after).toMatchObject({ pinnedAt: null, pinnedBy: null });
    // Unpinning answers the same for a message that isn't there.
    expect((await request('/api/meeting-messages/mmsg_nope/pin', { method: 'DELETE' })).status).toBe(200);
  });

  it('needs sessions:create to pin', async () => {
    expect((await app(['meetings:read']).request('/api/meeting-messages/mmsg_a1/pin', { method: 'POST' })).status).toBe(403);
  });
});

describe('POST /api/meeting-messages', () => {
  it('sends a message as the member, announces it and publishes an event', async () => {
    const { request } = app();
    const res = await request('/api/meeting-messages', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ meetingId: 'mtg_chat_b', content: 'hello', htmlContent: '<b>hello</b>' }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      meetingId: 'mtg_chat_b',
      authorId: ME,
      authorName: 'Mia Messenger',
      authorAvatar: 'https://cdn.example.com/mia.png',
      content: 'hello',
      htmlContent: '<b>hello</b>',
      type: 'message',
      attachments: null,
      hasAttachments: false,
      deletedAt: null,
      metadata: { htmlContent: '<b>hello</b>' },
    });
    expect(data.id).toMatch(/^mmsg_/);

    const [row] = await db.select().from(schema.meetingMessages).where(eq(schema.meetingMessages.id, data.id as string));
    expect(row).toMatchObject({ content: 'hello', authorName: 'Mia Messenger' });
    // Announced in the meeting's room.
    expect(realtime.published).toHaveLength(1);
    expect(realtime.published[0]).toMatchObject({ type: 'message', id: data.id, content: 'hello' });
    expect(events).toContainEqual(expect.objectContaining({ entityType: 'meeting_message', action: 'created' }));
  });

  it('sends attachments without text, as Unknown when the user is not a member', async () => {
    const { request } = createTestApp<Env, Variables>('/api/meeting-messages', meetingMessagesRoutes, {
      context: { permissions: permissions('sessions:create'), userId: 'user_not_a_member', tenantDb: db },
      env: { REALTIME: realtime.binding, ENTITY_EVENTS: eventsBinding } as unknown as Partial<Env>,
    });
    const attachment = { id: 'att_1', fileName: 'a.pdf', fileSize: 12, mimeType: 'application/pdf', url: 'https://cdn.example.com/a.pdf' };
    const res = await request('/api/meeting-messages', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ meetingId: 'mtg_chat_b', content: '', attachments: [attachment] }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: unknown }).data).toMatchObject({
      authorName: 'Unknown',
      authorAvatar: null,
      htmlContent: null,
      metadata: null,
      hasAttachments: true,
      attachments: [attachment],
    });
  });

  it('validates the body and the meeting', async () => {
    const { request } = app();
    const post = (body: unknown) => request('/api/meeting-messages', { method: 'POST', headers: json, body: JSON.stringify(body) });
    expect((await post({ meetingId: 'mtg_chat_a', content: '' })).status).toBe(400);
    expect((await post({ content: 'x' })).status).toBe(400);
    expect((await post({ meetingId: 'mtg_chat_a', content: 'x', htmlContent: 'x'.repeat(20_001) })).status).toBe(400);
    expect((await post({ meetingId: 'mtg_chat_a', content: 'x', attachments: [{ id: 'a' }] })).status).toBe(400);
    expect((await post({ meetingId: 'mtg_unknown', content: 'x' })).status).toBe(404);
    expect(
      (await app(['meetings:read']).request('/api/meeting-messages', { method: 'POST', headers: json, body: '{"meetingId":"mtg_chat_a","content":"x"}' }))
        .status,
    ).toBe(403);
  });
});

describe('DELETE /api/meeting-messages/:id (your own chat message)', () => {
  it("deletes the author's own message and announces it, refuses anyone else's", async () => {
    await db.insert(schema.meetingMessages).values([
      { id: 'mmsg_del_mine', meetingId: 'mtg_chat_b', authorId: ME, authorName: 'Mia', content: 'oops' },
      { id: 'mmsg_del_theirs', meetingId: 'mtg_chat_b', authorId: OTHER, authorName: 'Otto', content: 'mine' },
    ]);
    const { request } = app();

    expect((await request('/api/meeting-messages/mmsg_del_theirs', { method: 'DELETE' })).status).toBe(403);
    expect((await request('/api/meeting-messages/mmsg_del_mine?meetingId=mtg_chat_a', { method: 'DELETE' })).status).toBe(404);

    const res = await request('/api/meeting-messages/mmsg_del_mine?meetingId=mtg_chat_b', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.meetingMessages).where(eq(schema.meetingMessages.id, 'mmsg_del_mine'));
    expect(row?.deletedAt).toBeTruthy();
    expect(realtime.published).toHaveLength(1);
    expect(JSON.stringify(realtime.published[0])).toContain('mmsg_del_mine');
    expect(events).toContainEqual(expect.objectContaining({ entityType: 'meeting_message', action: 'deleted', entityId: 'mmsg_del_mine' }));

    expect((await request('/api/meeting-messages/mmsg_del_mine', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('generic rows', () => {
  it('reads one live message', async () => {
    const { request } = app();
    const res = await request('/api/meeting-messages/mmsg_a1');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toMatchObject({ id: 'mmsg_a1', content: 'first', meetingId: 'mtg_chat_a' });
    expect((await request('/api/meeting-messages/mmsg_a4')).status).toBe(404);
    expect((await request('/api/meeting-messages/mmsg_nope')).status).toBe(404);
  });

  it('updates a message and publishes the event', async () => {
    await db.insert(schema.meetingMessages).values({ id: 'mmsg_patch', meetingId: 'mtg_chat_b', authorId: OTHER, authorName: 'Otto', content: 'before' });
    const { request } = app();
    const res = await request('/api/meeting-messages/mmsg_patch', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ content: 'after', metadata: { edited: true }, unknownField: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'mmsg_patch' } });
    const [row] = await db.select().from(schema.meetingMessages).where(eq(schema.meetingMessages.id, 'mmsg_patch'));
    expect(row).toMatchObject({ content: 'after', metadata: { edited: true } });
    expect(events).toContainEqual(
      expect.objectContaining({ entityType: 'meeting_message', action: 'updated', data: expect.objectContaining({ meetingId: 'mtg_chat_b', authorId: OTHER, type: 'message' }) }),
    );

    expect((await request('/api/meeting-messages/mmsg_nope', { method: 'PATCH', headers: json, body: '{}' })).status).toBe(404);
    expect((await request('/api/meeting-messages/mmsg_patch', { method: 'PATCH', headers: json, body: '{"meetingId":5}' })).status).toBe(400);
    expect((await app(['meetings:read']).request('/api/meeting-messages/mmsg_patch', { method: 'PATCH', headers: json, body: '{}' })).status).toBe(403);
  });

  it('soft-deletes through the generic route', async () => {
    await db.insert(schema.meetingMessages).values({ id: 'mmsg_generic', meetingId: 'mtg_chat_b', authorId: OTHER, authorName: 'Otto', content: 'x' });
    const { request } = app();
    expect((await request('/api/meeting-messages/mmsg_generic/_generic', { method: 'DELETE' })).status).toBe(204);
    const [row] = await db.select().from(schema.meetingMessages).where(eq(schema.meetingMessages.id, 'mmsg_generic'));
    expect(row?.deletedAt).toBeTruthy();
    expect((await request('/api/meeting-messages/mmsg_generic/_generic', { method: 'DELETE' })).status).toBe(404);
    expect((await app(['meetings:read', 'sessions:create']).request('/api/meeting-messages/mmsg_a1/_generic', { method: 'DELETE' })).status).toBe(403);
  });
});
