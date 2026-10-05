/**
 * DB-backed tests for /api/channels: channel-name rules (trim, non-empty,
 * unique among public/private channels) and the caller's own mute flag.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { channelsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;

const OWNER = 'user_ch_names_owner';

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

function app(...perms: Parameters<typeof permissions>) {
  return createTestApp('/api/channels', channelsRoutes, {
    context: { userId: OWNER, permissions: permissions(...perms), tenantDb: db },
  });
}

type Requester = ReturnType<typeof app>['request'];

function createChannelVia(request: Requester, body: Record<string, unknown>) {
  return request('/api/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createdId(request: Requester, body: Record<string, unknown>): Promise<string> {
  const res = await createChannelVia(request, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

describe('/api/channels · names', () => {
  it('POST / rejects a whitespace-only name', async () => {
    const res = await createChannelVia(app('channels:create').request, { name: '   ' });
    expect(res.status).toBe(400);
  });

  it('POST / trims the stored name', async () => {
    const res = await createChannelVia(app('channels:create').request, { name: '  Padded Name  ' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { name: string } };
    expect(data.name).toBe('Padded Name');
  });

  it('POST / 409s a duplicate of a public channel (case-insensitive, trimmed)', async () => {
    const { request } = app('channels:create');
    expect((await createChannelVia(request, { name: 'general-dup', type: 'public' })).status).toBe(201);
    expect((await createChannelVia(request, { name: 'GENERAL-DUP', type: 'public' })).status).toBe(409);
    expect((await createChannelVia(request, { name: ' general-dup ', type: 'private' })).status).toBe(409);
  });

  it('POST / 409s a duplicate of a private channel the caller is in', async () => {
    const { request } = app('channels:create');
    // The creator is auto-joined as owner, so this private channel is visible to OWNER.
    expect((await createChannelVia(request, { name: 'mine-private', type: 'private' })).status).toBe(201);
    expect((await createChannelVia(request, { name: 'Mine-Private', type: 'public' })).status).toBe(409);
    expect((await createChannelVia(request, { name: 'mine-private', type: 'private' })).status).toBe(409);
  });

  it('POST / allows a duplicate of a private channel the caller is NOT in (no existence leak)', async () => {
    const now = new Date();
    const id = generateId('ch');
    await db.insert(schema.chatChannels).values({
      id, name: 'hidden-private', slug: 'hidden-private', type: 'private', createdAt: now, updatedAt: now,
    });
    await db.insert(schema.chatChannelMembers).values({
      id: generateId('cmb'), channelId: id, userId: 'user_someone_else', role: 'owner', createdAt: now, joinedAt: now,
    });

    const res = await createChannelVia(app('channels:create').request, { name: 'Hidden-Private' });
    expect(res.status).toBe(201);
    // Same slug as the hidden channel, resolved by the slug fallback rather than a 409.
    const { data } = (await res.json()) as { data: { slug: string; id: string } };
    expect(data.slug).toBe(`hidden-private-${data.id}`);
  });

  it('POST / allows reusing the name of a deleted channel', async () => {
    const { request } = app('channels:create');
    const id = await createdId(request, { name: 'was-deleted' });
    await db.update(schema.chatChannels).set({ deletedAt: new Date() }).where(eq(schema.chatChannels.id, id));
    expect((await createChannelVia(request, { name: 'was-deleted' })).status).toBe(201);
  });

  it('POST / ignores DM and entity channels for uniqueness', async () => {
    const now = new Date();
    for (const type of ['dm', 'entity']) {
      const id = generateId('ch');
      await db.insert(schema.chatChannels).values({
        id,
        name: `shared-${type}-name`,
        slug: `shared-${type}-${id}`,
        type,
        createdAt: now,
        updatedAt: now,
      });
      const res = await createChannelVia(app('channels:create').request, { name: `shared-${type}-name` });
      expect(res.status).toBe(201);
    }
  });

  it('PATCH /:id 409s a rename onto another channel, but allows keeping or re-casing its own name', async () => {
    const t = app('channels:create', 'channels:update');
    await createdId(t.request, { name: 'rename-a', type: 'private' });
    const b = await createdId(t.request, { name: 'rename-b', type: 'private' });
    const patch = (name: string) =>
      t.request(`/api/channels/${b}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

    expect((await patch('Rename-A')).status).toBe(409);
    expect((await patch('   ')).status).toBe(400);

    // Renaming onto a private channel the caller is NOT in is allowed.
    const now = new Date();
    const hiddenId = generateId('ch');
    await db.insert(schema.chatChannels).values({
      id: hiddenId, name: 'rename-hidden', slug: 'rename-hidden', type: 'private', createdAt: now, updatedAt: now,
    });
    await db.insert(schema.chatChannelMembers).values({
      id: generateId('cmb'), channelId: hiddenId, userId: 'user_someone_else', role: 'owner', createdAt: now, joinedAt: now,
    });
    expect((await patch('rename-hidden')).status).toBe(200);
    // ...and back, before the remaining own-name checks.
    expect((await patch('rename-b')).status).toBe(200);
    expect((await patch('rename-b')).status).toBe(200);
    expect((await patch('Rename-B')).status).toBe(200);
  });
});

describe('/api/channels · caller mute flag and archive', () => {
  it("GET / and GET /:id carry the caller's own isMuted flag", async () => {
    const t = app('channels:create', 'channels:read');
    const id = await createdId(t.request, { name: 'mute-flag-room', type: 'private' });

    const listMuted = async () => {
      const res = await t.request('/api/channels?search=mute-flag-room');
      const body = (await res.json()) as { data: { id: string; isMuted: boolean }[] };
      return body.data.find((r) => r.id === id)?.isMuted;
    };
    const getMuted = async () => {
      const res = await t.request(`/api/channels/${id}`);
      return ((await res.json()) as { data: { isMuted: boolean } }).data.isMuted;
    };

    expect(await listMuted()).toBe(false);
    expect(await getMuted()).toBe(false);

    await db
      .update(schema.chatChannelMembers)
      .set({ isMuted: true })
      .where(eq(schema.chatChannelMembers.channelId, id));
    expect(await listMuted()).toBe(true);
    expect(await getMuted()).toBe(true);
  });

  it('isMuted is false on a public channel the caller has no membership row for', async () => {
    const now = new Date();
    const id = generateId('ch');
    await db.insert(schema.chatChannels).values({
      id, name: 'no-row-public', slug: `no-row-public-${id}`, type: 'public', createdAt: now, updatedAt: now,
    });
    const res = await app('channels:read').request('/api/channels?search=no-row-public');
    const body = (await res.json()) as { data: { id: string; isMuted: boolean }[] };
    expect(body.data.find((r) => r.id === id)?.isMuted).toBe(false);
  });

  it('PATCH /:id { isArchived: false } un-archives a channel', async () => {
    const t = app('channels:create', 'channels:update');
    const id = await createdId(t.request, { name: 'archive-roundtrip', type: 'private' });
    const patch = (isArchived: boolean) =>
      t.request(`/api/channels/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isArchived }),
      });

    expect((await patch(true)).status).toBe(200);
    const res = await patch(false);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { isArchived: boolean } }).data.isArchived).toBe(false);
    const [row] = await db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, id));
    expect(row?.isArchived).toBe(false);
  });
});
