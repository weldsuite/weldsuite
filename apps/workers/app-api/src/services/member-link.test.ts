/**
 * pglite-backed test for ensureMemberLinked.
 *
 * An invited teammate whose row was flipped to ACTIVE by the
 * invitation.accepted webhook but never got their Clerk user id (the
 * membership.created sync missed) must be linked on their next request, so
 * permissions and installed apps resolve for them again.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';

vi.mock('@weldsuite/chat-domain/weldchat-auto-join', () => ({
  autoJoinUserToPublicChannels: vi.fn(async () => []),
}));
vi.mock('@weldsuite/chat-domain/weldchat-role-links', () => ({
  applyRoleChangeToChannels: vi.fn(async () => ({ added: [], removed: [] })),
}));
vi.mock('@weldsuite/chat-domain/realtime/weldchat-publisher', () => ({
  publishChatMemberJoined: vi.fn(),
  publishChatUserChannelNew: vi.fn(),
}));

import { ensureMemberLinked } from './member-link';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';

const { workspaceMembers } = schema;
const ORG_ID = 'org_test';

let db: Database;
const cache = new Map<string, string>();
const env = {
  CLERK_SECRET_KEY: 'sk_test',
  WORKSPACE_CACHE: {
    get: vi.fn(async (key: string) => cache.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      cache.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      cache.delete(key);
    }),
  },
} as unknown as Env;

function clerkMemberships(memberships: Array<{ orgId: string; role: string; email: string }>) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        data: memberships.map((m) => ({
          id: `orgmem_${m.orgId}`,
          organization: { id: m.orgId, name: 'Acme', slug: 'acme' },
          role: m.role,
          public_user_data: { identifier: m.email, first_name: 'New', last_name: 'Admin', image_url: null },
        })),
      }),
      { status: 200 },
    ),
  );
}

async function memberByUserId(userId: string) {
  const [row] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)));
  return row;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(workspaceMembers);
  cache.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ensureMemberLinked', () => {
  it('links an accepted invitation row that still has its placeholder user id', async () => {
    await db.insert(workspaceMembers).values({
      id: generateId('mbr'),
      userId: 'pending_clerk_orginv_1',
      email: 'new.admin@test.dev',
      role: 'ADMIN',
      status: 'ACTIVE',
      clerkInvitationId: 'orginv_1',
    });
    vi.stubGlobal('fetch', clerkMemberships([{ orgId: ORG_ID, role: 'org:admin', email: 'New.Admin@test.dev' }]));

    await ensureMemberLinked(env, db as never, ORG_ID, 'user_new');

    const row = await memberByUserId('user_new');
    expect(row).toBeDefined();
    expect(row.role).toBe('ADMIN');
    expect(row.status).toBe('ACTIVE');
    expect(row.clerkMembershipId).toBe(`orgmem_${ORG_ID}`);
    expect(row.name).toBe('New Admin');
  });

  it('links a returning member whose removed row still holds their user id', async () => {
    await db.insert(workspaceMembers).values([
      { id: 'mbr_removed', userId: 'user_back', email: 'back@test.dev', role: 'MEMBER', status: 'ACTIVE', deletedAt: new Date() },
      { id: 'mbr_reinvited', userId: 'pending_clerk_orginv_3', email: 'back@test.dev', role: 'ADMIN', status: 'PENDING', clerkInvitationId: 'orginv_3' },
    ]);
    vi.stubGlobal('fetch', clerkMemberships([{ orgId: ORG_ID, role: 'org:admin', email: 'back@test.dev' }]));

    await ensureMemberLinked(env, db as never, ORG_ID, 'user_back');

    // The live row is the only one left on the user id; the removed row keeps
    // its history under a freed id.
    const rows = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, 'user_back'));
    expect(rows.map((r) => r.id)).toEqual(['mbr_reinvited']);
    expect(rows[0]!.status).toBe('ACTIVE');
    const [removed] = await db.select().from(workspaceMembers).where(eq(workspaceMembers.id, 'mbr_removed'));
    expect(removed!.userId).toBe('removed_mbr_removed');
  });

  it('does not ask Clerk when the member is already linked', async () => {
    await db.insert(workspaceMembers).values({
      id: generateId('mbr'),
      userId: 'user_linked',
      email: 'linked@test.dev',
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await ensureMemberLinked(env, db as never, ORG_ID, 'user_linked');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves rows alone when Clerk has the user in another org only', async () => {
    await db.insert(workspaceMembers).values({
      id: generateId('mbr'),
      userId: 'pending_clerk_orginv_2',
      email: 'someone@test.dev',
      role: 'MEMBER',
      status: 'ACTIVE',
    });
    vi.stubGlobal('fetch', clerkMemberships([{ orgId: 'org_other', role: 'org:member', email: 'someone@test.dev' }]));

    await ensureMemberLinked(env, db as never, ORG_ID, 'user_someone');

    expect(await memberByUserId('user_someone')).toBeUndefined();
    expect(await memberByUserId('pending_clerk_orginv_2')).toBeDefined();
  });

  it('does not take over an already linked teammate with the same email', async () => {
    await db.insert(workspaceMembers).values({
      id: generateId('mbr'),
      userId: 'user_original',
      email: 'shared@test.dev',
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    vi.stubGlobal('fetch', clerkMemberships([{ orgId: ORG_ID, role: 'org:member', email: 'shared@test.dev' }]));

    await ensureMemberLinked(env, db as never, ORG_ID, 'user_intruder');

    expect(await memberByUserId('user_intruder')).toBeUndefined();
    expect((await memberByUserId('user_original'))?.role).toBe('ADMIN');
  });

  it('remembers a caller with nothing to link so the next request skips Clerk', async () => {
    const fetchMock = clerkMemberships([{ orgId: ORG_ID, role: 'org:member', email: 'dashboard-added@test.dev' }]);
    vi.stubGlobal('fetch', fetchMock);

    await ensureMemberLinked(env, db as never, ORG_ID, 'user_dashboard');
    await ensureMemberLinked(env, db as never, ORG_ID, 'user_dashboard');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks Clerk again after a failed lookup', async () => {
    const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await ensureMemberLinked(env, db as never, ORG_ID, 'user_retry');
    await ensureMemberLinked(env, db as never, ORG_ID, 'user_retry');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bumps the permission cache for the given workspace when a row is activated', async () => {
    await db.insert(workspaceMembers).values({
      id: generateId('mbr'),
      userId: 'pending_clerk_orginv_bump',
      email: 'bump@test.dev',
      role: 'ADMIN',
      status: 'ACTIVE',
      clerkInvitationId: 'orginv_bump',
    });
    vi.stubGlobal('fetch', clerkMemberships([{ orgId: ORG_ID, role: 'org:admin', email: 'bump@test.dev' }]));

    await ensureMemberLinked(env, db as never, ORG_ID, 'user_bump', 'ws_bump');

    expect(cache.get('permv:ws_bump')).toBe('1');
  });

  it('does not touch the permission cache when no workspace id is given', async () => {
    await db.insert(workspaceMembers).values({
      id: generateId('mbr'),
      userId: 'pending_clerk_orginv_nobump',
      email: 'nobump@test.dev',
      role: 'ADMIN',
      status: 'ACTIVE',
      clerkInvitationId: 'orginv_nobump',
    });
    vi.stubGlobal('fetch', clerkMemberships([{ orgId: ORG_ID, role: 'org:admin', email: 'nobump@test.dev' }]));

    await ensureMemberLinked(env, db as never, ORG_ID, 'user_nobump');

    expect([...cache.keys()].some((k) => k.startsWith('permv:'))).toBe(false);
  });
});
