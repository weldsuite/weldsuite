import { describe, it, expect, beforeAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { autoJoinUserToPublicChannels } from './weldchat-auto-join';
import { applyRoleChangeToChannels } from './weldchat-role-links';

let db: Database;

async function memberCounts(ids: string[]): Promise<Record<string, number>> {
  const rows = await db
    .select({ id: schema.chatChannels.id, memberCount: schema.chatChannels.memberCount })
    .from(schema.chatChannels)
    .where(inArray(schema.chatChannels.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.memberCount]));
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.roles).values([
    { id: 'role_old', name: 'Old role' },
    { id: 'role_new', name: 'New role' },
  ]);
  await db.insert(schema.chatChannels).values([
    { id: 'chan_pub_a', name: 'general', slug: 'general', type: 'public' },
    { id: 'chan_pub_b', name: 'random', slug: 'random', type: 'public' },
    { id: 'chan_priv', name: 'private', slug: 'private', type: 'private', memberCount: 7 },
    { id: 'chan_x', name: 'old-x', slug: 'old-x', type: 'private' },
    { id: 'chan_y', name: 'old-y', slug: 'old-y', type: 'private' },
    { id: 'chan_z', name: 'new-z', slug: 'new-z', type: 'private' },
  ]);
  await db.insert(schema.chatChannelRoleLinks).values([
    { id: 'crl_x', channelId: 'chan_x', roleId: 'role_old' },
    { id: 'crl_y', channelId: 'chan_y', roleId: 'role_old' },
    { id: 'crl_z', channelId: 'chan_z', roleId: 'role_new' },
  ]);
  await db.insert(schema.chatChannelMembers).values([
    { id: 'cmb_a_other', channelId: 'chan_pub_a', userId: 'user_other', role: 'member' },
    // Role-driven membership: removed on the role change.
    { id: 'cmb_x_u2', channelId: 'chan_x', userId: 'user_2', role: 'member', addedByRoleId: 'role_old' },
    { id: 'cmb_x_other', channelId: 'chan_x', userId: 'user_other', role: 'member' },
    // Manual join: sticky across the role change.
    { id: 'cmb_y_u2', channelId: 'chan_y', userId: 'user_2', role: 'member' },
  ]);
}, 60_000);

describe('autoJoinUserToPublicChannels', () => {
  it('joins every public channel and recounts only those channels', async () => {
    const joined = await autoJoinUserToPublicChannels(db, 'user_1', 'INTERNAL');

    expect(joined.map((c) => c.id).sort()).toEqual(['chan_pub_a', 'chan_pub_b']);
    expect(await memberCounts(['chan_pub_a', 'chan_pub_b', 'chan_priv'])).toEqual({
      chan_pub_a: 2,
      chan_pub_b: 1,
      chan_priv: 7,
    });
  });

  it('is a no-op for guests', async () => {
    expect(await autoJoinUserToPublicChannels(db, 'guest_1', 'GUEST')).toEqual([]);
  });
});

describe('applyRoleChangeToChannels', () => {
  it('drops role-driven memberships, keeps manual joins, adds new-role channels and recounts', async () => {
    const result = await applyRoleChangeToChannels(db, 'user_2', 'role_old', 'role_new');

    expect(result.removed).toEqual([{ channelId: 'chan_x', channelName: 'old-x', userIds: ['user_2'] }]);
    expect(result.added).toEqual([{ channelId: 'chan_z', channelName: 'new-z', userIds: ['user_2'] }]);

    const remaining = await db
      .select({ channelId: schema.chatChannelMembers.channelId })
      .from(schema.chatChannelMembers)
      .where(eq(schema.chatChannelMembers.userId, 'user_2'));
    expect(remaining.map((r) => r.channelId).sort()).toEqual(['chan_y', 'chan_z']);

    expect(await memberCounts(['chan_x', 'chan_y', 'chan_z'])).toEqual({
      chan_x: 1,
      chan_y: 0,
      chan_z: 1,
    });
  });
});
