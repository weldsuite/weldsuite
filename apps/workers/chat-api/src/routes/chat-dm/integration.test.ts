/**
 * DB-backed integration tests for /api/chat-dm (WeldChat): DMs are only ever
 * created for real workspace members who have accepted their invitation, and
 * the list carries the caller's mute flag.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatDmRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

const ALICE = 'user_dm_alice';
const BOB = 'user_dm_bob';
/** Invited through the team page: a PENDING row on the `invited_<email>` placeholder. */
const CAROL_INVITE = 'invited_carol@example.com';
/** Invited, with a real-looking id but the row still PENDING. */
const DAVE = 'user_dm_dave';
/** Accepted, but the Clerk webhook hasn't swapped in the real user id yet. */
const ERIN_INVITE = 'pending_clerk_inv_erin';

function app() {
  return createTestApp('/api/chat-dm', chatDmRoutes, {
    context: { userId: ALICE, permissions: permissions('messages:read', 'messages:create'), tenantDb: db },
  });
}

async function dmChannelCount(): Promise<number> {
  const rows = await db.select().from(schema.chatChannels).where(eq(schema.chatChannels.type, 'dm'));
  return rows.length;
}

type DmListItem = { id: string; isMuted: boolean };

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  const now = new Date();
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_dm_alice', userId: ALICE, email: 'alice@example.com', name: 'Alice', role: 'MEMBER', createdAt: now, updatedAt: now },
    { id: 'wm_dm_bob', userId: BOB, email: 'bob@example.com', name: 'Bob', role: 'MEMBER', createdAt: now, updatedAt: now },
    { id: 'wm_dm_carol', userId: CAROL_INVITE, email: 'carol@example.com', name: 'Carol', role: 'MEMBER', status: 'PENDING', createdAt: now, updatedAt: now },
    { id: 'wm_dm_dave', userId: DAVE, email: 'dave@example.com', name: 'Dave', role: 'MEMBER', status: 'PENDING', createdAt: now, updatedAt: now },
    { id: 'wm_dm_erin', userId: ERIN_INVITE, email: 'erin@example.com', name: 'Erin', role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
}, 60_000);

type ErrorBody = { error: { code: string; details?: { reason?: string; userIds?: string[] } } };

async function dmMembershipsOf(userId: string): Promise<number> {
  const rows = await db
    .select()
    .from(schema.chatChannelMembers)
    .where(eq(schema.chatChannelMembers.userId, userId));
  return rows.length;
}

describe('/api/chat-dm · workspace membership', () => {
  it('GET /:targetUserId 404s an id that is not a workspace member and creates nothing', async () => {
    const before = await dmChannelCount();
    const res = await app().request('/api/chat-dm/ch_not_a_user');
    expect(res.status).toBe(404);
    expect(await dmChannelCount()).toBe(before);
    const members = await db
      .select()
      .from(schema.chatChannelMembers)
      .where(eq(schema.chatChannelMembers.userId, 'ch_not_a_user'));
    expect(members).toHaveLength(0);
  });

  it('GET /:targetUserId creates the DM for a real member, then returns the same one', async () => {
    const first = await app().request(`/api/chat-dm/${BOB}`);
    expect(first.status).toBe(201);
    const created = (await first.json()) as { data: { id: string } };
    const second = await app().request(`/api/chat-dm/${BOB}`);
    expect(second.status).toBe(200);
    const again = (await second.json()) as { data: { id: string } };
    expect(again.data.id).toBe(created.data.id);
  });

  it('GET /:targetUserId still allows a DM with yourself', async () => {
    const res = await app().request(`/api/chat-dm/${ALICE}`);
    expect(res.status).toBe(201);
  });

  it('POST / 400s unknown user ids and creates nothing', async () => {
    const before = await dmChannelCount();
    const res = await app().request('/api/chat-dm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds: [BOB, 'user_ghost'] }),
    });
    expect(res.status).toBe(400);
    expect(await dmChannelCount()).toBe(before);
  });

  it("GET / lists the caller's DMs with their own isMuted flag", async () => {
    const resolved = await app().request(`/api/chat-dm/${BOB}`);
    const bobDm = ((await resolved.json()) as { data: { id: string } }).data;

    const fetchList = async () =>
      ((await (await app().request('/api/chat-dm')).json()) as { data: DmListItem[] }).data;

    expect((await fetchList()).find((d) => d.id === bobDm.id)?.isMuted).toBe(false);

    await db
      .update(schema.chatChannelMembers)
      .set({ isMuted: true })
      .where(eq(schema.chatChannelMembers.channelId, bobDm.id));
    expect((await fetchList()).find((d) => d.id === bobDm.id)?.isMuted).toBe(true);
  });
});

describe('/api/chat-dm · pending invitations', () => {
  it.each([
    ['an invited_ placeholder', CAROL_INVITE],
    ['a PENDING member', DAVE],
    ['a pending_clerk_ placeholder', ERIN_INVITE],
  ])('GET /:targetUserId 409s %s and creates nothing', async (_label, invitee) => {
    const before = await dmChannelCount();
    const res = await app().request(`/api/chat-dm/${encodeURIComponent(invitee)}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.details).toEqual({ reason: 'invitation_pending', userIds: [invitee] });
    expect(await dmChannelCount()).toBe(before);
    expect(await dmMembershipsOf(invitee)).toBe(0);
  });

  it('POST / 409s a group with an invitee in it and creates nothing', async () => {
    const before = await dmChannelCount();
    const res = await app().request('/api/chat-dm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds: [BOB, CAROL_INVITE, DAVE] }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.details).toEqual({ reason: 'invitation_pending', userIds: [CAROL_INVITE, DAVE] });
    expect(await dmChannelCount()).toBe(before);
  });

  it('opens the DM once the invitation is accepted', async () => {
    await db
      .update(schema.workspaceMembers)
      .set({ status: 'ACTIVE', acceptedAt: new Date() })
      .where(eq(schema.workspaceMembers.userId, DAVE));
    const res = await app().request(`/api/chat-dm/${DAVE}`);
    expect(res.status).toBe(201);
  });
});
