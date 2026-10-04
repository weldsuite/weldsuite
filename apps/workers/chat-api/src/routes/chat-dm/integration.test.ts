/**
 * DB-backed integration tests for /api/chat-dm (WeldChat): DMs are only ever
 * created for real workspace members, and the list carries the caller's mute flag.
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
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
}, 60_000);

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
