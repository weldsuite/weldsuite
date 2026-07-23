/**
 * DB-backed integration tests for /api/channel-members (WeldChat).
 *
 * The subject here is the PERMISSION TIER. SYSTEM_ROLES.MEMBER resolves to
 * exactly: messages:read/create/update/delete + channels:read + channels:create.
 * It does NOT hold channels:update or channels:delete — so any self-service
 * action gated on those is a guaranteed 403 for every ordinary user, no matter
 * what the in-handler authorization says. These tests pin the self-service
 * paths (leave, mute) to the baseline tier a MEMBER actually has.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { channelMembersRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

let db: Database;

/** The exact permission set SYSTEM_ROLES.MEMBER resolves to. */
const MEMBER_PERMISSIONS = [
  'messages:read',
  'messages:create',
  'messages:update',
  'messages:delete',
  'channels:read',
  'channels:create',
];

const MEMBER = 'user_cm_member';
const OWNER = 'user_cm_owner';

let channelId: string;
let memberRowId: string;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  const now = new Date();
  channelId = generateId('ch');
  memberRowId = generateId('chm');

  await db.insert(schema.chatChannels).values({
    id: channelId,
    name: 'cm-channel',
    slug: `cm-channel-${channelId}`,
    type: 'public',
    memberCount: 2,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.chatChannelMembers).values([
    { id: generateId('chm'), channelId, userId: OWNER, role: 'owner', createdAt: now, joinedAt: now },
    { id: memberRowId, channelId, userId: MEMBER, role: 'member', createdAt: now, joinedAt: now },
  ]);
}, 60_000);

describe('/api/channel-members · MEMBER-tier self-service', () => {
  it('PATCH /:id lets a plain member mute their own membership', async () => {
    const { request } = createTestApp('/api/channel-members', channelMembersRoutes, {
      context: { userId: MEMBER, permissions: permissions(...MEMBER_PERMISSIONS), tenantDb: db },
    });
    const res = await request(`/api/channel-members/${memberRowId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isMuted: true }),
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.chatChannelMembers)
      .where(eq(schema.chatChannelMembers.id, memberRowId))
      .limit(1);
    expect(row?.isMuted).toBe(true);
  });

  it('PATCH /:id ignores a role escalation from a non-moderator', async () => {
    const { request } = createTestApp('/api/channel-members', channelMembersRoutes, {
      context: { userId: MEMBER, permissions: permissions(...MEMBER_PERMISSIONS), tenantDb: db },
    });
    const res = await request(`/api/channel-members/${memberRowId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'owner' }),
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.chatChannelMembers)
      .where(eq(schema.chatChannelMembers.id, memberRowId))
      .limit(1);
    expect(row?.role).toBe('member');
  });

  it('DELETE /:id lets a plain member leave, and decrements memberCount', async () => {
    const { request } = createTestApp('/api/channel-members', channelMembersRoutes, {
      context: { userId: MEMBER, permissions: permissions(...MEMBER_PERMISSIONS), tenantDb: db },
    });
    const res = await request(`/api/channel-members/${memberRowId}`, { method: 'DELETE' });
    // Was 403 while this route was gated on channels:delete — a permission the
    // MEMBER role does not hold — so leaving was impossible for normal users.
    expect(res.status).toBe(204);

    const rows = await db
      .select()
      .from(schema.chatChannelMembers)
      .where(and(eq(schema.chatChannelMembers.channelId, channelId), eq(schema.chatChannelMembers.userId, MEMBER)));
    expect(rows).toHaveLength(0);

    const [channel] = await db
      .select()
      .from(schema.chatChannels)
      .where(eq(schema.chatChannels.id, channelId))
      .limit(1);
    expect(channel?.memberCount).toBe(1);
  });

  it('DELETE /:id still forbids a plain member from kicking someone else', async () => {
    const now = new Date();
    const victimRowId = generateId('chm');
    const intruder = 'user_cm_intruder';
    await db.insert(schema.chatChannelMembers).values([
      { id: victimRowId, channelId, userId: 'user_cm_victim', role: 'member', createdAt: now, joinedAt: now },
      { id: generateId('chm'), channelId, userId: intruder, role: 'member', createdAt: now, joinedAt: now },
    ]);

    const { request } = createTestApp('/api/channel-members', channelMembersRoutes, {
      context: { userId: intruder, permissions: permissions(...MEMBER_PERMISSIONS), tenantDb: db },
    });
    const res = await request(`/api/channel-members/${victimRowId}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });
});
