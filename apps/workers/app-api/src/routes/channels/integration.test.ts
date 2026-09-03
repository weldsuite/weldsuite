/**
 * DB-backed integration tests for /api/channels (WeldChat).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { channelsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/channels · pglite integration', () => {
  it('POST / writes a channel and derives slug from name', async () => {
    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: { permissions: permissions('channels:create'), tenantDb: db },
    });

    const res = await request('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Engineering Team' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^ch_/);

    const [row] = await db
      .select()
      .from(schema.chatChannels)
      .where(eq(schema.chatChannels.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Engineering Team');
    expect(row?.slug).toBe('engineering-team');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: { permissions: permissions('channels:create'), tenantDb: db },
    });
    const res = await request('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST / auto-joins the creator as owner and denormalises memberCount', async () => {
    const creator = 'user_ch_creator';
    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: { userId: creator, permissions: permissions('channels:create'), tenantDb: db },
    });

    const res = await request('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Owner Check', type: 'private' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; memberCount: number } };

    // The creator must hold an owner membership — without it they cannot see
    // the private channel they just made.
    const members = await db
      .select()
      .from(schema.chatChannelMembers)
      .where(eq(schema.chatChannelMembers.channelId, body.data.id));
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe(creator);
    expect(members[0].role).toBe('owner');

    const [row] = await db
      .select()
      .from(schema.chatChannels)
      .where(eq(schema.chatChannels.id, body.data.id))
      .limit(1);
    expect(row?.memberCount).toBe(1);
    expect(row?.createdBy).toBe(creator);
  });

  it('POST / fans a public channel out to every active internal member and honours memberIds', async () => {
    const now = new Date();
    const creator = 'user_fanout_creator';
    const colleague = 'user_fanout_colleague';
    const guest = 'user_fanout_guest';
    const inactive = 'user_fanout_inactive';

    await db.insert(schema.workspaceMembers).values([
      { id: generateId('wm'), userId: creator, email: 'c@x.io', name: 'Creator', status: 'ACTIVE', memberType: 'INTERNAL', createdAt: now, updatedAt: now },
      { id: generateId('wm'), userId: colleague, email: 'k@x.io', name: 'Colleague', status: 'ACTIVE', memberType: 'INTERNAL', createdAt: now, updatedAt: now },
      { id: generateId('wm'), userId: guest, email: 'g@x.io', name: 'Guest', status: 'ACTIVE', memberType: 'EXTERNAL_GUEST', createdAt: now, updatedAt: now },
      { id: generateId('wm'), userId: inactive, email: 'i@x.io', name: 'Inactive', status: 'INACTIVE', memberType: 'INTERNAL', createdAt: now, updatedAt: now },
    ]);

    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: { userId: creator, permissions: permissions('channels:create'), tenantDb: db },
    });
    const res = await request('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `memberIds` used to hit a non-existent column and 500 the insert.
      body: JSON.stringify({ name: 'Fanout Room', type: 'public', memberIds: [guest] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };

    const members = await db
      .select()
      .from(schema.chatChannelMembers)
      .where(eq(schema.chatChannelMembers.channelId, body.data.id));
    const memberIds = members.map((m) => m.userId).sort();

    // Creator + every ACTIVE INTERNAL member + the explicitly invited guest.
    expect(memberIds).toEqual([colleague, guest, creator].sort());
    // An INACTIVE member is not swept in by the fan-out.
    expect(memberIds).not.toContain(inactive);

    const [row] = await db
      .select()
      .from(schema.chatChannels)
      .where(eq(schema.chatChannels.id, body.data.id))
      .limit(1);
    expect(row?.memberCount).toBe(3);
  });

  it('POST /:channelId/members batch-adds, maintains memberCount, and DELETE reverses it', async () => {
    const now = new Date();
    const admin = 'user_batch_admin';
    const invitee = 'user_batch_invitee';
    const channelId = generateId('ch');

    await db.insert(schema.chatChannels).values({
      id: channelId, name: 'batch', slug: `batch-${channelId}`, type: 'private',
      memberCount: 1, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.chatChannelMembers).values({
      id: generateId('cmb'), channelId, userId: admin, role: 'owner', createdAt: now, joinedAt: now,
    });
    await db.insert(schema.workspaceMembers).values({
      id: generateId('wm'), userId: invitee, email: 'inv@x.io', name: 'Invitee',
      status: 'ACTIVE', memberType: 'INTERNAL', createdAt: now, updatedAt: now,
    });

    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: { userId: admin, permissions: permissions('channels:update'), tenantDb: db },
    });

    const addRes = await request(`/api/channels/${channelId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds: [invitee] }),
    });
    expect(addRes.status).toBe(201);
    expect((await addRes.json() as { data: { addedCount: number } }).data.addedCount).toBe(1);

    let [row] = await db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, channelId)).limit(1);
    expect(row?.memberCount).toBe(2);

    // Re-adding an existing member is a no-op — the count must not drift.
    const dupRes = await request(`/api/channels/${channelId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds: [invitee] }),
    });
    expect(dupRes.status).toBe(201);
    [row] = await db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, channelId)).limit(1);
    expect(row?.memberCount).toBe(2);

    // Removal is keyed by USER id, not the membership row id.
    const delRes = await request(`/api/channels/${channelId}/members/${invitee}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    [row] = await db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, channelId)).limit(1);
    expect(row?.memberCount).toBe(1);
  });

  it('POST /:channelId/members rejects a user who is not in the workspace', async () => {
    const now = new Date();
    const admin = 'user_reject_admin';
    const channelId = generateId('ch');
    await db.insert(schema.chatChannels).values({
      id: channelId, name: 'reject', slug: `reject-${channelId}`, type: 'private',
      memberCount: 1, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.chatChannelMembers).values({
      id: generateId('cmb'), channelId, userId: admin, role: 'owner', createdAt: now, joinedAt: now,
    });

    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: { userId: admin, permissions: permissions('channels:update'), tenantDb: db },
    });
    const res = await request(`/api/channels/${channelId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds: ['user_not_in_workspace'] }),
    });
    expect(res.status).toBe(400);
  });

  it('GET / hides private channels from non-members and shows them to members', async () => {
    const now = new Date();
    const pubId = generateId('ch');
    const privId = generateId('ch');
    const member = 'user_ch_member';
    const outsider = 'user_ch_outsider';

    await db.insert(schema.chatChannels).values([
      { id: pubId, name: 'list-public', slug: `list-public-${pubId}`, type: 'public', createdAt: now, updatedAt: now },
      { id: privId, name: 'list-private', slug: `list-private-${privId}`, type: 'private', createdAt: now, updatedAt: now },
    ]);
    await db.insert(schema.chatChannelMembers).values({
      id: generateId('cmb'),
      channelId: privId,
      userId: member,
      role: 'member',
      createdAt: now,
      joinedAt: now,
    });

    // Outsider: sees the public channel, NOT the private one.
    const outApp = createTestApp('/api/channels', channelsRoutes, {
      context: { userId: outsider, permissions: permissions('channels:read'), tenantDb: db },
    });
    const outRes = await outApp.request('/api/channels?limit=100');
    expect(outRes.status).toBe(200);
    const outBody = (await outRes.json()) as { data: { id: string }[] };
    const outIds = outBody.data.map((r) => r.id);
    expect(outIds).toContain(pubId);
    expect(outIds).not.toContain(privId);

    // Member: sees both.
    const memApp = createTestApp('/api/channels', channelsRoutes, {
      context: { userId: member, permissions: permissions('channels:read'), tenantDb: db },
    });
    const memRes = await memApp.request('/api/channels?limit=100');
    expect(memRes.status).toBe(200);
    const memBody = (await memRes.json()) as { data: { id: string }[] };
    const memIds = memBody.data.map((r) => r.id);
    expect(memIds).toContain(pubId);
    expect(memIds).toContain(privId);
  });

  it('DELETE /:id lets a workspace ADMIN delete a public channel they never joined', async () => {
    const now = new Date();
    const wsAdmin = 'user_ws_admin_delete';
    const channelId = generateId('ch');

    // The admin has NO chatChannelMembers row for this channel — the previous
    // isChannelModerator() only read that row, so this 403'd.
    await db.insert(schema.chatChannels).values({
      id: channelId, name: 'admin-delete', slug: `admin-delete-${channelId}`, type: 'public',
      memberCount: 0, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.workspaceMembers).values({
      id: generateId('wm'), userId: wsAdmin, email: 'wsadmin@x.io', name: 'WS Admin',
      role: 'ADMIN', status: 'ACTIVE', memberType: 'INTERNAL', createdAt: now, updatedAt: now,
    });

    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: { userId: wsAdmin, permissions: permissions('channels:delete'), tenantDb: db },
    });
    const res = await request(`/api/channels/${channelId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    const [row] = await db
      .select()
      .from(schema.chatChannels)
      .where(eq(schema.chatChannels.id, channelId))
      .limit(1);
    expect(row?.deletedAt).not.toBeNull();
  });

  it('DELETE /:id still refuses a plain MEMBER who is not a channel moderator', async () => {
    const now = new Date();
    const plain = 'user_ws_plain_delete';
    const channelId = generateId('ch');

    await db.insert(schema.chatChannels).values({
      id: channelId, name: 'member-delete', slug: `member-delete-${channelId}`, type: 'public',
      memberCount: 0, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.workspaceMembers).values({
      id: generateId('wm'), userId: plain, email: 'plain@x.io', name: 'Plain',
      role: 'MEMBER', status: 'ACTIVE', memberType: 'INTERNAL', createdAt: now, updatedAt: now,
    });

    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: { userId: plain, permissions: permissions('channels:delete'), tenantDb: db },
    });
    const res = await request(`/api/channels/${channelId}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('DELETE /:id does not let a workspace ADMIN reach a private channel they are not in', async () => {
    const now = new Date();
    const wsAdmin = 'user_ws_admin_private';
    const insider = 'user_private_insider';
    const channelId = generateId('ch');

    await db.insert(schema.chatChannels).values({
      id: channelId, name: 'admin-private', slug: `admin-private-${channelId}`, type: 'private',
      memberCount: 1, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.chatChannelMembers).values({
      id: generateId('cmb'), channelId, userId: insider, role: 'owner', createdAt: now, joinedAt: now,
    });
    await db.insert(schema.workspaceMembers).values({
      id: generateId('wm'), userId: wsAdmin, email: 'wsadmin2@x.io', name: 'WS Admin 2',
      role: 'ADMIN', status: 'ACTIVE', memberType: 'INTERNAL', createdAt: now, updatedAt: now,
    });

    // canAccessChannel() runs first and 404s — the membership boundary on
    // private channels / DMs is unchanged by the moderator fallback.
    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: { userId: wsAdmin, permissions: permissions('channels:delete'), tenantDb: db },
    });
    const res = await request(`/api/channels/${channelId}`, { method: 'DELETE' });
    expect(res.status).toBe(404);

    const [row] = await db
      .select()
      .from(schema.chatChannels)
      .where(eq(schema.chatChannels.id, channelId))
      .limit(1);
    expect(row?.deletedAt).toBeNull();
  });
});
