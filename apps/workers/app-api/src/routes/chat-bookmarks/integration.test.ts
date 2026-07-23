/**
 * DB-backed integration tests for /api/chat-bookmarks (WeldChat) — focused on
 * the owner boundary: a bookmark is private to its author.
 *
 * Permission args here are scaffolding to clear the route gate, not the subject
 * of these assertions. They track the `messages:*` tier the routes now use (and
 * that the legacy api-worker bookmark handlers used): a bookmark is a personal
 * resource, and SYSTEM_ROLES.MEMBER holds messages:* but not channels:update /
 * channels:delete.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatBookmarksRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

let db: Database;

const ALICE = 'user_alice_bk';
const BOB = 'user_bob_bk';

let channelId: string;
let messageId: string;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  const now = new Date();
  channelId = generateId('ch');
  messageId = generateId('cmsg');

  await db.insert(schema.chatChannels).values({
    id: channelId,
    name: 'bk-channel',
    slug: `bk-channel-${channelId}`,
    type: 'public',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.chatMessages).values({
    id: messageId,
    channelId,
    authorId: ALICE,
    authorName: 'Alice',
    content: 'bookmark me',
    createdAt: now,
    updatedAt: now,
  });

  // Bob bookmarks the message.
  await db.insert(schema.chatBookmarks).values({
    id: generateId('cbk'),
    userId: BOB,
    messageId,
    channelId,
    note: 'bob note',
    createdAt: now,
  });
}, 60_000);

describe('/api/chat-bookmarks · owner boundary', () => {
  it('GET / returns only the caller’s bookmarks even with a spoofed userId filter', async () => {
    const { request } = createTestApp('/api/chat-bookmarks', chatBookmarksRoutes, {
      context: { userId: ALICE, permissions: permissions('messages:read'), tenantDb: db },
    });
    const res = await request(`/api/chat-bookmarks?userId=${BOB}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { userId: string }[] };
    expect(body.data.every((b) => b.userId === ALICE)).toBe(true);
    expect(body.data.length).toBe(0);
  });

  it('POST / stamps the caller as owner, ignoring a body userId', async () => {
    const { request } = createTestApp('/api/chat-bookmarks', chatBookmarksRoutes, {
      context: { userId: ALICE, permissions: permissions('messages:create'), tenantDb: db },
    });
    const res = await request('/api/chat-bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: BOB, messageId, channelId, note: 'alice note' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.chatBookmarks)
      .where(eq(schema.chatBookmarks.id, body.data.id))
      .limit(1);
    expect(row?.userId).toBe(ALICE);
  });

  it('GET / hydrates the message + channel the bookmarks UI renders', async () => {
    const { request } = createTestApp('/api/chat-bookmarks', chatBookmarksRoutes, {
      context: { userId: BOB, permissions: permissions('messages:read'), tenantDb: db },
    });
    const res = await request('/api/chat-bookmarks');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        messageContent: string;
        messageAuthorName: string;
        channelName: string;
        channelSlug: string;
        channelType: string;
      }>;
    };
    expect(body.data.length).toBeGreaterThan(0);
    // A bare chat_bookmarks row carries ids only; every field below comes from
    // the left-joins and is rendered by the bookmarks page/panel/popover.
    const bk = body.data[0];
    expect(bk.messageContent).toBe('bookmark me');
    expect(bk.messageAuthorName).toBe('Alice');
    expect(bk.channelName).toBe('bk-channel');
    expect(bk.channelType).toBe('public');
  });

  it('POST / is idempotent — re-bookmarking a message does not 500 on the unique index', async () => {
    const { request } = createTestApp('/api/chat-bookmarks', chatBookmarksRoutes, {
      context: { userId: BOB, permissions: permissions('messages:create'), tenantDb: db },
    });
    const res = await request('/api/chat-bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, channelId }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { alreadyExists: boolean } }).data.alreadyExists).toBe(true);
  });

  it('GET /:id 404s another user’s bookmark', async () => {
    const [bobBk] = await db
      .select()
      .from(schema.chatBookmarks)
      .where(eq(schema.chatBookmarks.userId, BOB))
      .limit(1);

    const { request } = createTestApp('/api/chat-bookmarks', chatBookmarksRoutes, {
      context: { userId: ALICE, permissions: permissions('messages:read'), tenantDb: db },
    });
    const res = await request(`/api/chat-bookmarks/${bobBk.id}`);
    expect(res.status).toBe(404);
  });
});
