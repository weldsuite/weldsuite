/**
 * DB-backed integration tests for /api/channels (WeldChat).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { channelsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

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

  it('POST / reuses a taken name (live, private or deleted) without 500ing', async () => {
    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: { permissions: permissions('channels:create'), tenantDb: db },
    });
    const create = async (body: Record<string, unknown>) => {
      const res = await request('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: { id: string; slug: string } };
      return data;
    };

    const first = await create({ name: 'Slug Clash', type: 'public' });
    expect(first.slug).toBe('slug-clash');
    // Soft-deleted rows keep their slug — the name must still be reusable.
    await db
      .update(schema.chatChannels)
      .set({ deletedAt: new Date() })
      .where(eq(schema.chatChannels.id, first.id));

    const second = await create({ name: 'Slug Clash', type: 'public' });
    const third = await create({ name: 'slug clash!', type: 'private' });
    expect(second.slug).toBe(`slug-clash-${second.id}`);
    expect(third.slug).toBe(`slug-clash-${third.id}`);
  });

  it('PATCH /:id rename onto a taken slug does not 500', async () => {
    const owner = 'user_ch_rename_owner';
    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: {
        userId: owner,
        permissions: permissions('channels:create', 'channels:update'),
        tenantDb: db,
      },
    });
    const post = async (name: string) => {
      const res = await request('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type: 'private' }),
      });
      return ((await res.json()) as { data: { id: string } }).data.id;
    };
    // A live channel with this name would be a 409 (see names.integration.test.ts);
    // a soft-deleted one still holds the slug, which is the case under test.
    const targetId = await post('Rename Target');
    await db
      .update(schema.chatChannels)
      .set({ deletedAt: new Date() })
      .where(eq(schema.chatChannels.id, targetId));
    const id = await post('Rename Source');

    const res = await request(`/api/channels/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Rename Target' }),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { slug: string } };
    expect(data.slug).toBe(`rename-target-${id}`);
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

  it('GET /?types= lists only those types, so newer DMs and record chats cannot push channels off the page', async () => {
    const caller = 'user_ch_types_filter';
    const base = Date.now() - 3_600_000;
    const at = (offsetMs: number) => new Date(base + offsetMs);

    // The caller's private channel is the OLDEST row; 30 DMs and 5 record chats
    // the caller is in are all newer. Without the filter they fill a page first.
    const privId = generateId('ch');
    const dmIds = Array.from({ length: 30 }, () => generateId('ch'));
    const entityIds = Array.from({ length: 5 }, () => generateId('ch'));
    await db.insert(schema.chatChannels).values([
      { id: privId, name: 'types-private', slug: `types-private-${privId}`, type: 'private', createdAt: at(0), updatedAt: at(0) },
      ...dmIds.map((id, i) => ({
        id, name: `types-dm-${i}`, slug: `types-dm-${id}`, type: 'dm', createdAt: at(1000 + i), updatedAt: at(1000 + i),
      })),
      ...entityIds.map((id, i) => ({
        id, name: `types-entity-${i}`, slug: `types-entity-${id}`, type: 'entity',
        entityType: 'company', entityId: generateId('cus'), createdAt: at(2000 + i), updatedAt: at(2000 + i),
      })),
    ]);
    await db.insert(schema.chatChannelMembers).values(
      [privId, ...dmIds, ...entityIds].map((channelId) => ({
        id: generateId('cmb'), channelId, userId: caller, role: 'member', createdAt: at(0), joinedAt: at(0),
      })),
    );

    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: { userId: caller, permissions: permissions('channels:read'), tenantDb: db },
    });
    type Page = { data: { id: string; type: string }[]; pagination: { totalCount: number } };
    const get = async (path: string): Promise<Page> => {
      const res = await request(path);
      expect(res.status).toBe(200);
      return (await res.json()) as Page;
    };

    // Unfiltered, the default page of 25 is all DMs and record chats.
    const unfiltered = await get('/api/channels');
    expect(unfiltered.data.map((r) => r.id)).not.toContain(privId);

    const filtered = await get('/api/channels?types=public,private&limit=100');
    expect(filtered.data.map((r) => r.id)).toContain(privId);
    expect(filtered.data.every((r) => r.type === 'public' || r.type === 'private')).toBe(true);

    // The total counts the filtered list, also when the cursor does not resolve.
    const privateOnly = await get('/api/channels?types=private');
    const staleCursor = await get('/api/channels?types=private&cursor=ch_does_not_exist');
    expect(staleCursor.pagination.totalCount).toBe(privateOnly.pagination.totalCount);
    expect(staleCursor.data.every((r) => r.type === 'private')).toBe(true);
  });

  it('GET /?types= refuses an unknown channel type', async () => {
    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: { userId: 'user_ch_types_unknown', permissions: permissions('channels:read'), tenantDb: db },
    });
    const res = await request('/api/channels?types=public,channel');
    expect(res.status).toBe(400);
  });

  it('GET / pages through every channel with the cursor, without repeats', async () => {
    const caller = 'user_ch_cursor_pages';
    const base = Date.now() - 7_200_000;
    const ids = Array.from({ length: 5 }, () => generateId('ch'));
    await db.insert(schema.chatChannels).values(
      ids.map((id, i) => ({
        id, name: `pages-${i}`, slug: `pages-${id}`, type: 'private',
        createdAt: new Date(base + i * 1000), updatedAt: new Date(base + i * 1000),
      })),
    );
    await db.insert(schema.chatChannelMembers).values(
      ids.map((channelId) => ({
        id: generateId('cmb'), channelId, userId: caller, role: 'member', createdAt: new Date(base), joinedAt: new Date(base),
      })),
    );

    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: { userId: caller, permissions: permissions('channels:read'), tenantDb: db },
    });
    type Page = { data: { id: string }[]; pagination: { hasMore: boolean; cursor: string | null } };
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const qs: string = `?types=private&search=pages-&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await request(`/api/channels${qs}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Page;
      seen.push(...body.data.map((r) => r.id));
      if (!body.pagination.hasMore) break;
      cursor = body.pagination.cursor;
    }
    expect(seen).toEqual([...ids].reverse());
  });

  it('GET / returns the caller\'s read cursor, and POST /:id/read moves it past lastMessageAt', async () => {
    const earlier = new Date(Date.now() - 60_000);
    const channelId = generateId('ch');
    const reader = 'user_ch_read_cursor';
    const otherReader = 'user_ch_read_cursor_other';

    await db.insert(schema.chatChannels).values({
      id: channelId, name: 'read-cursor', slug: `read-cursor-${channelId}`, type: 'public',
      createdAt: earlier, updatedAt: earlier, lastMessageAt: earlier,
    });
    await db.insert(schema.chatChannelMembers).values([
      { id: generateId('cmb'), channelId, userId: reader, role: 'member', createdAt: earlier, joinedAt: earlier, unreadMentionCount: 2 },
      { id: generateId('cmb'), channelId, userId: otherReader, role: 'member', createdAt: earlier, joinedAt: earlier, lastReadAt: earlier },
    ]);

    const { request } = createTestApp('/api/channels', channelsRoutes, {
      context: { userId: reader, permissions: permissions('channels:read'), tenantDb: db },
    });
    type Row = { id: string; lastMessageAt: string | null; lastReadAt: string | null; unreadMentionCount: number };
    const listRow = async (): Promise<Row | undefined> => {
      const res = await request('/api/channels?limit=100');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Row[] };
      return body.data.find((r) => r.id === channelId);
    };

    // Never read: the caller's own cursor (not another member's) comes back.
    const before = await listRow();
    expect(before?.lastReadAt).toBeNull();
    expect(before?.unreadMentionCount).toBe(2);

    const read = await request(`/api/channels/${channelId}/read`, { method: 'POST' });
    expect(read.status).toBe(200);

    const after = await listRow();
    expect(after?.lastReadAt).not.toBeNull();
    expect(new Date(after!.lastReadAt!).getTime()).toBeGreaterThan(new Date(after!.lastMessageAt!).getTime());
    expect(after?.unreadMentionCount).toBe(0);
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

  describe('agents in rooms', () => {
    const now = new Date();
    const member = 'user_agent_room_member';
    let openAgent: string;
    let hiddenAgent: string;

    beforeAll(async () => {
      openAgent = generateId('agt');
      hiddenAgent = generateId('agt');
      await db.insert(schema.weldagentAgents).values([
        { id: openAgent, name: 'Researcher', status: 'active', visibility: 'workspace', ownerId: 'user_someone_else' },
        { id: hiddenAgent, name: 'Private helper', status: 'active', visibility: 'private', ownerId: 'user_someone_else' },
      ]);
    });

    async function room(type: 'public' | 'private' | 'dm', withMember = true): Promise<string> {
      const channelId = generateId('ch');
      await db.insert(schema.chatChannels).values({
        id: channelId, name: `room-${channelId}`, slug: `room-${channelId}`, type,
        memberCount: withMember ? 1 : 0, createdAt: now, updatedAt: now,
      });
      if (withMember) {
        await db.insert(schema.chatChannelMembers).values({
          id: generateId('cmb'), channelId, userId: member, role: 'member', createdAt: now, joinedAt: now,
        });
      }
      return channelId;
    }

    function asMember(perms: string[] = ['weldagent:use']) {
      return createTestApp('/api/channels', channelsRoutes, {
        context: { userId: member, permissions: permissions(...perms), tenantDb: db },
      }).request;
    }

    const invite = (request: ReturnType<typeof asMember>, channelId: string, agentIds: string[]) =>
      request(`/api/channels/${channelId}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentIds }),
      });

    it('POST /:channelId/agents lets a plain member bring in an agent they can use, and DELETE takes it out', async () => {
      const channelId = await room('private');
      const request = asMember();

      const res = await invite(request, channelId, [openAgent]);
      expect(res.status).toBe(201);
      expect(((await res.json()) as { data: { addedAgentIds: string[] } }).data.addedAgentIds).toEqual([openAgent]);

      const [row] = await db
        .select({ memberType: schema.chatChannelMembers.memberType })
        .from(schema.chatChannelMembers)
        .where(and(eq(schema.chatChannelMembers.channelId, channelId), eq(schema.chatChannelMembers.userId, openAgent)));
      expect(row?.memberType).toBe('agent');
      let [channel] = await db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, channelId));
      expect(channel?.memberCount).toBe(2);

      // Inviting it again changes nothing.
      const again = await invite(request, channelId, [openAgent]);
      expect(((await again.json()) as { data: { addedAgentIds: string[] } }).data.addedAgentIds).toEqual([]);

      const del = await request(`/api/channels/${channelId}/agents/${openAgent}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      [channel] = await db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, channelId));
      expect(channel?.memberCount).toBe(1);
    });

    it('brings in a draft or paused agent too: it still answers when tagged', async () => {
      const draft = generateId('agt');
      const paused = generateId('agt');
      await db.insert(schema.weldagentAgents).values([
        { id: draft, name: 'New helper', status: 'draft', visibility: 'workspace' },
        { id: paused, name: 'Resting helper', status: 'paused', visibility: 'workspace' },
      ]);
      const channelId = await room('public');
      const res = await invite(asMember(), channelId, [draft, paused]);
      expect(res.status).toBe(201);
      expect(((await res.json()) as { data: { addedAgentIds: string[] } }).data.addedAgentIds.sort()).toEqual(
        [draft, paused].sort(),
      );
    });

    it('brings an agent into a record chat the caller may read', async () => {
      const companyId = generateId('cmp');
      await db.insert(schema.companies).values({
        id: companyId, name: 'Agent Corp', displayName: 'Agent Corp', createdAt: now, updatedAt: now,
      } as unknown as typeof schema.companies.$inferInsert);
      const channelId = generateId('ch');
      await db.insert(schema.chatChannels).values({
        id: channelId, name: 'Agent Corp', slug: `rec-${channelId}`, type: 'entity',
        entityType: 'company', entityId: companyId, entityDisplayName: 'Agent Corp',
        memberCount: 0, createdAt: now, updatedAt: now,
      });

      const crm = ['weldagent:use', 'companies:read', 'companies:scope:all'];
      expect((await invite(asMember(crm), channelId, [openAgent])).status).toBe(201);
      // Without the record's permission the chat is out of reach.
      expect((await invite(asMember(['weldagent:use']), channelId, [openAgent])).status).toBe(403);
    });

    it('refuses an agent the caller cannot see', async () => {
      const channelId = await room('public');
      const res = await invite(asMember(), channelId, [hiddenAgent]);
      expect(res.status).toBe(403);
    });

    it('refuses a private room the caller is not in, and DMs', async () => {
      const outside = await room('private', false);
      expect((await invite(asMember(), outside, [openAgent])).status).toBe(403);
      const dm = await room('dm');
      expect((await invite(asMember(), dm, [openAgent])).status).toBe(400);
    });

    it('needs weldagent:use', async () => {
      const channelId = await room('public');
      expect((await invite(asMember(['channels:read']), channelId, [openAgent])).status).toBe(403);
    });

    it('DELETE /:channelId/agents/:agentId refuses an agent the caller cannot use', async () => {
      const channelId = await room('private');
      await db.insert(schema.chatChannelMembers).values({
        id: generateId('cmb'), channelId, userId: hiddenAgent, memberType: 'agent', role: 'member',
        createdAt: now, joinedAt: now,
      });
      const res = await asMember()(`/api/channels/${channelId}/agents/${hiddenAgent}`, { method: 'DELETE' });
      expect(res.status).toBe(403);
      const [row] = await db
        .select({ id: schema.chatChannelMembers.id })
        .from(schema.chatChannelMembers)
        .where(and(eq(schema.chatChannelMembers.channelId, channelId), eq(schema.chatChannelMembers.userId, hiddenAgent)));
      expect(row).toBeDefined();
    });

    it('DELETE /:channelId/agents/:agentId still clears a deleted agent nobody can use', async () => {
      const goneAgent = generateId('agt');
      await db.insert(schema.weldagentAgents).values({
        id: goneAgent, name: 'Retired helper', status: 'active', visibility: 'private',
        ownerId: 'user_someone_else', deletedAt: new Date(),
      });
      const channelId = await room('private');
      await db.insert(schema.chatChannelMembers).values({
        id: generateId('cmb'), channelId, userId: goneAgent, memberType: 'agent', role: 'member',
        createdAt: now, joinedAt: now,
      });
      const res = await asMember()(`/api/channels/${channelId}/agents/${goneAgent}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
    });

    it('DELETE /:channelId/agents/:agentId only removes agents', async () => {
      const channelId = await room('private');
      const res = await asMember()(`/api/channels/${channelId}/agents/${member}`, { method: 'DELETE' });
      expect(res.status).toBe(400);
    });
  });
});
