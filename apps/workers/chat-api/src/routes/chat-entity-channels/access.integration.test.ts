/**
 * Reading a record chat follows access to the record, not membership
 * (ADR CHAT-003), across the generic WeldChat routes: a colleague who may see
 * the company reads and posts in its chat without following it, and a
 * follower who lost CRM access loses the chat everywhere (history, channel
 * list, directory, search, forwarding).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { channelsRoutes } from '../channels';
import { chatDirectoriesRoutes } from '../chat-directories';
import { chatSearchRoutes } from '../chat-search';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;

// The route gates (requirePermission) read these; canAccessChannel resolves the
// user's grants from workspace_members, seeded below.
const PERMS = permissions(
  'channels:read',
  'channels:create',
  'messages:read',
  'messages:create',
  'companies:read',
  'companies:scope:all',
);

const ADMIN = 'u_acc_admin';
const LOST = 'u_acc_lost';
let lostMemberId: string;
let companyChat: string;
let companyMessage: string;
let privateChannel: string;

async function member(userId: string, role: string): Promise<string> {
  const id = generateId('wm');
  await db.insert(schema.workspaceMembers).values({
    id,
    userId,
    email: `${userId}@example.com`,
    name: userId,
    role,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as typeof schema.workspaceMembers.$inferInsert);
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await member(ADMIN, 'ADMIN');
  lostMemberId = await member(LOST, 'ADMIN');

  const companyId = generateId('cmp');
  await db.insert(schema.companies).values({
    id: companyId,
    name: 'Forecast BV',
    displayName: 'Forecast BV',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as typeof schema.companies.$inferInsert);

  companyChat = generateId('ch');
  privateChannel = generateId('ch');
  await db.insert(schema.chatChannels).values([
    {
      id: companyChat,
      name: 'Forecast BV',
      slug: `forecast-${companyChat}`,
      type: 'entity',
      entityType: 'company',
      entityId: companyId,
      entityDisplayName: 'Forecast BV',
      lastMessagePreview: 'the quarterly forecast',
      lastMessageAt: new Date(),
      memberCount: 1,
    },
    { id: privateChannel, name: 'Team room', slug: `team-${privateChannel}`, type: 'private', memberCount: 1 },
  ]);
  await db.insert(schema.chatChannelMembers).values([
    { id: generateId('cmb'), channelId: companyChat, userId: LOST },
    { id: generateId('cmb'), channelId: privateChannel, userId: LOST },
  ]);
  companyMessage = generateId('msg');
  await db.insert(schema.chatMessages).values({
    id: companyMessage,
    channelId: companyChat,
    authorId: LOST,
    authorName: LOST,
    content: 'the quarterly forecast is in',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}, 60_000);

/** `denies` mirrors workspace_members.permissionDenies, as the real permission middleware would. */
function as(userId: string, denies: string[] = []) {
  const opts = { context: { userId, permissions: { ...PERMS, denies }, tenantDb: db } };
  const channels = createTestApp('/api/channels', channelsRoutes, opts);
  const search = createTestApp('/api/chat-search', chatSearchRoutes, opts);
  const directories = createTestApp('/api/chat-directories', chatDirectoriesRoutes, opts);
  return {
    channels: channels.request,
    search: search.request,
    directories: directories.request,
  };
}

describe('record chats · reading follows the record', () => {
  it('lets a colleague who may see the company read and post without following; posting follows', async () => {
    const admin = as(ADMIN);

    expect((await admin.channels(`/api/channels/${companyChat}`)).status).toBe(200);
    const history = await admin.channels(`/api/channels/${companyChat}/messages`);
    expect(history.status).toBe(200);
    expect(JSON.stringify(await history.json())).toContain(companyMessage);

    const post = await admin.channels(`/api/channels/${companyChat}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Thanks, reviewing it now' }),
    });
    expect(post.status).toBe(201);
    const [follow] = await db
      .select({ id: schema.chatChannelMembers.id })
      .from(schema.chatChannelMembers)
      .where(and(eq(schema.chatChannelMembers.channelId, companyChat), eq(schema.chatChannelMembers.userId, ADMIN)));
    expect(follow).toBeDefined();
  });

  it('takes the chat away from a follower who lost CRM access, everywhere', async () => {
    // Before: the follower reads it like anyone with access.
    expect((await as(LOST).channels(`/api/channels/${companyChat}/messages`)).status).toBe(200);

    await db
      .update(schema.workspaceMembers)
      .set({ permissionDenies: ['companies:read'] })
      .where(eq(schema.workspaceMembers.id, lostMemberId));
    const lost = as(LOST, ['companies:read']);

    expect((await lost.channels(`/api/channels/${companyChat}`)).status).toBe(404);
    expect((await lost.channels(`/api/channels/${companyChat}/messages`)).status).toBe(403);
    const send = await lost.channels(`/api/channels/${companyChat}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'still here?' }),
    });
    expect(send.status).toBe(403);

    // The channel list and the directory no longer show it (its name and last
    // message preview are the record's); the private channel stays.
    const listed = (await (await lost.channels('/api/channels?limit=100')).json()) as { data: Array<{ id: string }> };
    expect(listed.data.map((c) => c.id)).not.toContain(companyChat);
    expect(listed.data.map((c) => c.id)).toContain(privateChannel);
    const directory = (await (await lost.directories('/api/chat-directories/channels')).json()) as {
      data: Array<{ id: string }>;
    };
    expect(directory.data.map((c) => c.id)).not.toContain(companyChat);

    const found = (await (await lost.search('/api/chat-search?q=forecast')).json()) as {
      data: { messages: Array<{ id: string }> };
    };
    expect(found.data.messages.map((m) => m.id)).not.toContain(companyMessage);

    const forward = await lost.channels(`/api/channels/${companyChat}/messages/${companyMessage}/forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetChannelIds: [privateChannel] }),
    });
    expect(forward.status).toBe(403);
  });
});
