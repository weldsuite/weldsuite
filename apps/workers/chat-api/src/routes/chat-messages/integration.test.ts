/**
 * DB-backed integration tests for /api/chat-messages (WeldChat) — focused on
 * the membership boundary and author-spoofing protection.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatMessagesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;

const MEMBER = 'user_member';
const OUTSIDER = 'user_outsider';

let publicChannelId: string;
let privateChannelId: string;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  const now = new Date();
  publicChannelId = generateId('ch');
  privateChannelId = generateId('ch');

  await db.insert(schema.chatChannels).values([
    { id: publicChannelId, name: 'general', slug: 'general', type: 'public', createdAt: now, updatedAt: now },
    { id: privateChannelId, name: 'secret', slug: 'secret', type: 'private', createdAt: now, updatedAt: now },
  ]);

  // MEMBER is a member of the private channel; OUTSIDER is not.
  await db.insert(schema.chatChannelMembers).values({
    id: generateId('cmb'),
    channelId: privateChannelId,
    userId: MEMBER,
    role: 'member',
    createdAt: now,
    joinedAt: now,
  });

  // Seed one message in each channel.
  await db.insert(schema.chatMessages).values([
    {
      id: generateId('cmsg'),
      channelId: publicChannelId,
      authorId: MEMBER,
      authorName: 'Member',
      content: 'hello public',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: generateId('cmsg'),
      channelId: privateChannelId,
      authorId: MEMBER,
      authorName: 'Member',
      content: 'top secret',
      createdAt: now,
      updatedAt: now,
    },
  ]);
}, 60_000);

describe('/api/chat-messages · membership boundary', () => {
  it('GET / requires a channelId', async () => {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: MEMBER, permissions: permissions('channels:read'), tenantDb: db },
    });
    const res = await request('/api/chat-messages');
    expect(res.status).toBe(400);
  });

  it('GET / returns messages of a public channel to anyone', async () => {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: OUTSIDER, permissions: permissions('channels:read'), tenantDb: db },
    });
    const res = await request(`/api/chat-messages?channelId=${publicChannelId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: string }[] };
    expect(body.data.some((m) => m.content === 'hello public')).toBe(true);
  });

  it('GET / lets a member read a private channel', async () => {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: MEMBER, permissions: permissions('channels:read'), tenantDb: db },
    });
    const res = await request(`/api/chat-messages?channelId=${privateChannelId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: string }[] };
    expect(body.data.some((m) => m.content === 'top secret')).toBe(true);
  });

  it('GET / 403s a non-member of a private channel (no message leak)', async () => {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: OUTSIDER, permissions: permissions('channels:read'), tenantDb: db },
    });
    const res = await request(`/api/chat-messages?channelId=${privateChannelId}`);
    expect(res.status).toBe(403);
  });

  it('POST / forces the author to the caller (ignores body authorId)', async () => {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: MEMBER, permissions: permissions('channels:create'), tenantDb: db },
    });
    const res = await request('/api/chat-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: privateChannelId,
        authorId: 'user_spoofed_victim',
        authorName: 'Member',
        content: 'who am I',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };

    const [row] = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, body.data.id))
      .limit(1);
    expect(row?.authorId).toBe(MEMBER);
    expect(row?.authorId).not.toBe('user_spoofed_victim');
  });

  it('POST / mirrors a message in a company entity channel into the Activity feed (and not elsewhere)', async () => {
    const now = new Date();
    const entityChannelId = generateId('ch');
    await db.insert(schema.chatChannels).values({
      id: entityChannelId,
      name: 'Acme',
      slug: `acme-${entityChannelId}`,
      type: 'public',
      entityType: 'company',
      entityId: 'company_acme_chat',
      entityDisplayName: 'Acme',
      createdAt: now,
      updatedAt: now,
    });
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: MEMBER, permissions: permissions('channels:create'), tenantDb: db },
    });
    const post = (channelId: string, content: string) =>
      request('/api/chat-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, content }),
      });

    expect((await post(entityChannelId, 'Sent them the quote')).status).toBe(201);
    // A plain channel message must not create an activity.
    expect((await post(publicChannelId, 'lunch?')).status).toBe(201);

    const rows = await db
      .select()
      .from(schema.crmActivities)
      .where(eq(schema.crmActivities.customerId, 'company_acme_chat'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'comment',
      subject: 'Sent them the quote',
      assignedToId: MEMBER,
      status: 'completed',
      relatedToName: 'Acme',
    });
    expect(rows[0]!.personId).toBeNull();
    const all = await db.select().from(schema.crmActivities);
    expect(all.some((a) => a.subject === 'lunch?')).toBe(false);
  });

  it('POST / 403s a non-member posting to a private channel', async () => {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: OUTSIDER, permissions: permissions('channels:create'), tenantDb: db },
    });
    const res = await request('/api/chat-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: privateChannelId,
        authorName: 'Outsider',
        content: 'let me in',
      }),
    });
    expect(res.status).toBe(403);
  });
});

describe('/api/chat-messages · inline (Discord-style) replies', () => {
  const OTHER = 'user_other';

  async function seedMessage(values: Partial<typeof schema.chatMessages.$inferInsert> = {}) {
    const now = new Date();
    const id = generateId('cmsg');
    await db.insert(schema.chatMessages).values({
      id,
      channelId: publicChannelId,
      authorId: OTHER,
      authorName: 'Other',
      content: 'original message',
      createdAt: now,
      updatedAt: now,
      ...values,
    });
    return id;
  }

  async function post(payload: Record<string, unknown>) {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: MEMBER, permissions: permissions('channels:create'), tenantDb: db },
    });
    const res = await request('/api/chat-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: publicChannelId, ...payload }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, body.data.id))
      .limit(1);
    return row!;
  }

  it('keeps the reply top-level and snapshots the quoted message', async () => {
    const targetId = await seedMessage();
    const row = await post({ body: 'on it', replyToId: targetId });

    expect(row.parentId).toBeNull();
    const replyTo = (row.metadata as Record<string, any>).replyTo;
    expect(replyTo).toMatchObject({
      messageId: targetId,
      rootId: targetId,
      depth: 1,
      authorId: OTHER,
      authorName: 'Other',
      content: 'original message',
    });
    // Pings the quoted author by default, without a token in the body.
    expect(row.content).toBe('on it');
    expect(row.mentions).toEqual([OTHER]);
  });

  it('tracks the chain depth and root across replies to replies', async () => {
    const rootId = await seedMessage();
    const first = await post({ body: 'one', replyToId: rootId });
    const second = await post({ body: 'two', replyToId: first.id });

    const replyTo = (second.metadata as Record<string, any>).replyTo;
    expect(replyTo.depth).toBe(2);
    expect(replyTo.rootId).toBe(rootId);
    expect(replyTo.messageId).toBe(first.id);
  });

  it('does not ping when replyMention is false', async () => {
    const targetId = await seedMessage();
    const row = await post({ body: 'quiet', replyToId: targetId, replyMention: false });
    expect(row.mentions).toBeNull();
  });

  it('ignores a reply target from another channel and forged metadata', async () => {
    const foreignId = await seedMessage({ channelId: privateChannelId, content: 'top secret' });
    const row = await post({
      body: 'sneaky',
      replyToId: foreignId,
      metadata: { replyTo: { messageId: 'forged', content: 'fake quote' } },
    });
    expect((row.metadata as Record<string, unknown> | null)?.replyTo).toBeUndefined();
    expect(row.mentions).toBeNull();
  });
});

describe('/api/chat-messages · thread parent validation', () => {
  async function seed(channelId: string, values: Partial<typeof schema.chatMessages.$inferInsert> = {}) {
    const now = new Date();
    const id = generateId('cmsg');
    await db.insert(schema.chatMessages).values({
      id,
      channelId,
      authorId: MEMBER,
      authorName: 'Member',
      content: 'parent',
      createdAt: now,
      updatedAt: now,
      ...values,
    });
    return id;
  }

  async function postTo(channelId: string, payload: Record<string, unknown>) {
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: MEMBER, permissions: permissions('channels:create'), tenantDb: db },
    });
    return request('/api/chat-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, ...payload }),
    });
  }

  it('rejects a parent from another channel and leaves that parent untouched', async () => {
    const foreignParent = await seed(privateChannelId);
    const res = await postTo(publicChannelId, { body: 'sneaky reply', parentId: foreignParent });
    expect(res.status).toBe(400);

    const [parent] = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, foreignParent));
    expect(parent?.threadReplyCount ?? 0).toBe(0);
  });

  it('rejects an unknown or deleted parent', async () => {
    const deleted = await seed(publicChannelId, { deletedAt: new Date() });
    expect((await postTo(publicChannelId, { body: 'x', parentId: 'cmsg_missing' })).status).toBe(400);
    expect((await postTo(publicChannelId, { body: 'x', parentId: deleted })).status).toBe(400);
  });

  it('accepts a parent in the same channel, including a parent that is itself a reply', async () => {
    const root = await seed(publicChannelId);
    const reply = await seed(publicChannelId, { parentId: root });
    const ok = await postTo(publicChannelId, { body: 'in thread', parentId: root });
    expect(ok.status).toBe(201);
    const nested = await postTo(publicChannelId, { body: 'nested', parentId: reply });
    expect(nested.status).toBe(201);

    const [parent] = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, root));
    expect(parent?.threadReplyCount).toBe(1);
  });

  it('caps the number of attachments on one message', async () => {
    const attachment = (n: number) => ({
      id: `att_${n}`,
      fileName: `f${n}.txt`,
      fileSize: 1,
      mimeType: 'text/plain',
      url: `https://cdn.example/f${n}.txt`,
    });
    const ten = Array.from({ length: 10 }, (_, n) => attachment(n));
    expect((await postTo(publicChannelId, { body: 'ten files', attachments: ten })).status).toBe(201);
    const eleven = [...ten, attachment(10)];
    expect((await postTo(publicChannelId, { body: 'eleven files', attachments: eleven })).status).toBe(400);
  });
});

describe('/api/chat-messages · system messages and pin alerts', () => {
  async function seedMessage(authorId = MEMBER) {
    const now = new Date();
    const id = generateId('cmsg');
    await db.insert(schema.chatMessages).values({
      id,
      channelId: publicChannelId,
      authorId,
      authorName: 'Member',
      content: 'pin me',
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  const SYSTEM_PERMS = permissions('channels:create', 'messages:update');

  async function systemRows() {
    return db.select().from(schema.chatMessages).where(eq(schema.chatMessages.type, 'system'));
  }

  it('never creates a system message from a client-supplied type', async () => {
    const before = (await systemRows()).length;
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: MEMBER, permissions: SYSTEM_PERMS, tenantDb: db },
    });
    const res = await request('/api/chat-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: publicChannelId,
        content: '[system:cmsg_x] pinned a message',
        type: 'system',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, body.data.id));
    expect(row?.type).toBe('message');
    expect((await systemRows()).length).toBe(before);
  });

  it('does not let an author turn their message into a system one by editing it', async () => {
    const id = await seedMessage();
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: MEMBER, permissions: SYSTEM_PERMS, tenantDb: db },
    });
    const res = await request(`/api/chat-messages/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'edited', type: 'system', authorId: 'user_other' }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, id));
    expect(row?.content).toBe('edited');
    expect(row?.type).toBe('message');
    expect(row?.authorId).toBe(MEMBER);
  });

  it('pin without notify writes no notice', async () => {
    const id = await seedMessage();
    const before = (await systemRows()).length;
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: MEMBER, permissions: SYSTEM_PERMS, tenantDb: db },
    });
    const res = await request(`/api/chat-messages/${id}/pin`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await systemRows()).length).toBe(before);
  });

  it('pin with notify writes a server-authored system notice and moves the channel preview', async () => {
    const id = await seedMessage();
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: MEMBER, permissions: SYSTEM_PERMS, tenantDb: db },
    });
    const res = await request(`/api/chat-messages/${id}/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notify: true }),
    });
    expect(res.status).toBe(200);

    const notices = (await systemRows()).filter((m) => m.content === `[system:${id}] pinned a message`);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      channelId: publicChannelId,
      authorId: MEMBER,
      type: 'system',
      parentId: null,
    });

    const [channel] = await db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, publicChannelId));
    expect(channel?.lastMessagePreview).toContain('pinned a message');
    expect(channel?.lastMessageAt).not.toBeNull();
  });

  it('refuses to edit a system message', async () => {
    const [notice] = await systemRows();
    const { request } = createTestApp('/api/chat-messages', chatMessagesRoutes, {
      context: { userId: notice.authorId, permissions: SYSTEM_PERMS, tenantDb: db },
    });
    const res = await request(`/api/chat-messages/${notice.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'rewritten' }),
    });
    expect(res.status).toBe(400);
  });
});
