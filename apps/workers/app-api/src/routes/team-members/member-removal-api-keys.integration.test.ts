/**
 * DB-backed tests: removing a member revokes their personal API keys.
 *
 * A personal `wsk_` key is the member's own credential, so it must not outlive
 * their membership:
 *   - DELETE /:id soft-deletes the member's live `api_keys` rows (the same
 *     revoke DELETE /api/api-keys/:id does) and drops each key's master
 *     `api_key_registry` entry.
 *   - POST /sync does the same for members whose Clerk membership is gone.
 *   - Other people's keys, the member's already-revoked keys and workspace keys
 *     are left alone.
 *   - A registry failure never fails the removal.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { teamMembersRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

// No master database in these tests: record what would be deleted from
// `api_key_registry` instead.
const master = vi.hoisted(() => ({
  conditions: [] as unknown[],
  fail: false,
}));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => ({
      delete: () => ({
        where: async (condition: unknown) => {
          if (master.fail) throw new Error('master unavailable');
          master.conditions.push(condition);
        },
      }),
    }),
  };
});

const { workspaceMembers, apiKeys, workspaceApiKeys } = schema;
let db: Database;
let clerkCalls: string[];
let clerkMemberships: string[];

/** The tenant key ids whose registry entry was deleted, read back out of the SQL params. */
function unregisteredKeyIds(): string[] {
  const dialect = new PgDialect();
  return master.conditions.flatMap((condition) =>
    dialect.sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0]).params.map(String),
  );
}

async function liveKeyIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.deletedAt)));
  return rows.map((r) => r.id).sort();
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  const now = new Date();

  await db.insert(workspaceMembers).values([
    { id: 'wm_rm_owner', userId: 'user_rm_owner', email: 'owner@example.com', role: 'OWNER', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'wm_rm_leaver', userId: 'user_rm_leaver', email: 'leaver@example.com', role: 'MEMBER', status: 'ACTIVE', clerkMembershipId: 'orgmem_leaver', createdAt: now, updatedAt: now },
    { id: 'wm_rm_stayer', userId: 'user_rm_stayer', email: 'stayer@example.com', role: 'MEMBER', status: 'ACTIVE', clerkMembershipId: 'orgmem_stayer', createdAt: now, updatedAt: now },
    { id: 'wm_rm_gone', userId: 'user_rm_gone', email: 'gone@example.com', role: 'MEMBER', status: 'ACTIVE', clerkMembershipId: 'orgmem_gone', createdAt: now, updatedAt: now },
    { id: 'wm_rm_pending', userId: 'invited_pending@example.com', email: 'pending@example.com', role: 'MEMBER', status: 'PENDING', clerkInvitationId: 'orginv_pending', createdAt: now, updatedAt: now },
  ] as (typeof workspaceMembers.$inferInsert)[]);

  const key = (id: string, userId: string, extra: Partial<typeof apiKeys.$inferInsert> = {}) =>
    ({ id, name: id, keyHash: `hash_${id}`, keyPrefix: 'wsk_test', userId, scopes: ['people:read'], ...extra }) as typeof apiKeys.$inferInsert;

  await db.insert(apiKeys).values([
    key('ak_rm_leaver_1', 'user_rm_leaver'),
    key('ak_rm_leaver_2', 'user_rm_leaver'),
    key('ak_rm_leaver_old', 'user_rm_leaver', { deletedAt: new Date(now.getTime() - 86_400_000) }),
    key('ak_rm_stayer_1', 'user_rm_stayer'),
    key('ak_rm_gone_1', 'user_rm_gone'),
    key('ak_rm_gone_2', 'user_rm_gone'),
  ]);

  // Created by the leaver, but a workspace credential: it stays.
  await db.insert(workspaceApiKeys).values({
    id: 'wak_rm_ci',
    name: 'ci',
    keyHash: 'hash_wak_rm_ci',
    keyPrefix: 'wsk_test',
    createdBy: 'user_rm_leaver',
    scopes: ['*'],
  });
}, 60_000);

beforeEach(() => {
  master.conditions = [];
  master.fail = false;
  clerkCalls = [];
  clerkMemberships = ['orgmem_stayer'];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    clerkCalls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/memberships?')) return Response.json({ data: clerkMemberships.map((id) => ({ id })) });
    if (url.includes('/invitations?')) return Response.json({ data: [{ id: 'orginv_pending' }] });
    // Membership removal.
    return new Response(null, { status: 204 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function app(...extra: string[]) {
  return createTestApp('/api/team-members', teamMembersRoutes, {
    context: { tenantDb: db, orgId: 'org_rm', permissions: permissions('team:read', 'team:delete', ...extra) },
  });
}

describe('DELETE /:id', () => {
  it('revokes the removed member\'s live personal keys and drops them from the registry', async () => {
    expect(await liveKeyIds('user_rm_leaver')).toEqual(['ak_rm_leaver_1', 'ak_rm_leaver_2']);

    const res = await app().request('/api/team-members/wm_rm_leaver', { method: 'DELETE' });
    expect(res.status).toBe(204);

    // Removed from Clerk by user id, then the member row and the keys.
    expect(clerkCalls.some((call) => call.startsWith('DELETE') && call.endsWith('/memberships/user_rm_leaver'))).toBe(true);
    const [member] = await db.select({ deletedAt: workspaceMembers.deletedAt }).from(workspaceMembers).where(eq(workspaceMembers.id, 'wm_rm_leaver'));
    expect(member?.deletedAt).not.toBeNull();

    expect(await liveKeyIds('user_rm_leaver')).toEqual([]);
    const revoked = await db.select({ id: apiKeys.id, deletedAt: apiKeys.deletedAt }).from(apiKeys).where(eq(apiKeys.userId, 'user_rm_leaver'));
    expect(revoked).toHaveLength(3);
    expect(revoked.every((row) => row.deletedAt !== null)).toBe(true);

    // The registry loses exactly the two keys that were live (the third was
    // revoked long ago and its entry already removed then).
    expect(unregisteredKeyIds().sort()).toEqual(['ak_rm_leaver_1', 'ak_rm_leaver_2']);
  });

  it('leaves other members\' keys and workspace keys alone', async () => {
    expect(await liveKeyIds('user_rm_stayer')).toEqual(['ak_rm_stayer_1']);

    const [workspaceKey] = await db
      .select({ deletedAt: workspaceApiKeys.deletedAt })
      .from(workspaceApiKeys)
      .where(eq(workspaceApiKeys.id, 'wak_rm_ci'));
    expect(workspaceKey?.deletedAt).toBeNull();
  });

  it('does not fail the removal when the registry cannot be reached', async () => {
    master.fail = true;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await app().request('/api/team-members/wm_rm_gone', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    // The tenant rows are revoked all the same: that is what external-api reads live.
    expect(await liveKeyIds('user_rm_gone')).toEqual([]);
  });

  it('cancels a pending invitation without touching any keys', async () => {
    const res = await app().request('/api/team-members/wm_rm_pending', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(master.conditions).toHaveLength(0);
    expect(await liveKeyIds('user_rm_stayer')).toEqual(['ak_rm_stayer_1']);
  });

  it('refuses to remove the owner and revokes nothing', async () => {
    const res = await app().request('/api/team-members/wm_rm_owner', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(master.conditions).toHaveLength(0);
  });
});

describe('POST /sync', () => {
  beforeAll(async () => {
    // wm_rm_gone was removed above; give the sync a member to find.
    await db.insert(workspaceMembers).values({
      id: 'wm_rm_vanished',
      userId: 'user_rm_vanished',
      email: 'vanished@example.com',
      role: 'MEMBER',
      status: 'ACTIVE',
      clerkMembershipId: 'orgmem_vanished',
    } as typeof workspaceMembers.$inferInsert);
    await db.insert(apiKeys).values({
      id: 'ak_rm_vanished_1',
      name: 'ak_rm_vanished_1',
      keyHash: 'hash_ak_rm_vanished_1',
      keyPrefix: 'wsk_test',
      userId: 'user_rm_vanished',
      scopes: ['people:read'],
    });
  });

  it('revokes the keys of members whose Clerk membership is gone', async () => {
    // Clerk still has the stayer (and nobody else with a membership id).
    clerkMemberships = ['orgmem_stayer'];

    const res = await app().request('/api/team-members/sync', { method: 'POST' });
    expect(res.status).toBe(200);

    const [vanished] = await db.select({ deletedAt: workspaceMembers.deletedAt }).from(workspaceMembers).where(eq(workspaceMembers.id, 'wm_rm_vanished'));
    expect(vanished?.deletedAt).not.toBeNull();
    expect(await liveKeyIds('user_rm_vanished')).toEqual([]);
    expect(unregisteredKeyIds()).toEqual(['ak_rm_vanished_1']);

    // The member Clerk still lists, and the owner without a Clerk membership id, are untouched.
    expect(await liveKeyIds('user_rm_stayer')).toEqual(['ak_rm_stayer_1']);
    const [stayer] = await db.select({ deletedAt: workspaceMembers.deletedAt }).from(workspaceMembers).where(eq(workspaceMembers.id, 'wm_rm_stayer'));
    expect(stayer?.deletedAt).toBeNull();
    const [owner] = await db.select({ deletedAt: workspaceMembers.deletedAt }).from(workspaceMembers).where(eq(workspaceMembers.id, 'wm_rm_owner'));
    expect(owner?.deletedAt).toBeNull();
  });
});
