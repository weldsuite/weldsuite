/**
 * DB-backed tests for POST /invite against soft-deleted member rows.
 *
 *   - A removed member keeps their row (soft delete), user_id included, and
 *     user_id is unique over every row. Re-inviting the same address frees
 *     the old row's `invited_<email>` placeholder first, so the invite goes
 *     through and the new row is the only one on that user id.
 *   - When the PENDING row can't be written, the Clerk invitation created a
 *     moment earlier is revoked, so no invite is left behind for an error.
 *
 * Linking the real Clerk user id on accept is covered in
 * services/member-link.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
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

// No seat cap in these tests: the seat check reads the master DB and Clerk.
vi.mock('../../services/seat-limits', () => ({ getWorkspaceSeatLimit: vi.fn(async () => null) }));

const { workspaceMembers } = schema;
let db: Database;
let clerkCalls: Array<{ method: string; url: string }>;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  const now = new Date();
  await db.insert(workspaceMembers).values([
    // An earlier invite that was cancelled.
    { id: 'wm_old_invite', userId: 'invited_back@example.com', email: 'back@example.com', role: 'MEMBER', status: 'PENDING', deletedAt: now, createdAt: now, updatedAt: now },
    // A member who was removed, still holding their real Clerk user id.
    { id: 'wm_removed', userId: 'user_returning', email: 'returning@example.com', role: 'MEMBER', status: 'ACTIVE', deletedAt: now, createdAt: now, updatedAt: now },
    // A live row already holding the placeholder the next invite would use.
    { id: 'wm_taken', userId: 'invited_Taken@example.com', role: 'MEMBER', status: 'PENDING', createdAt: now, updatedAt: now },
  ] as (typeof workspaceMembers.$inferInsert)[]);
}, 60_000);

beforeEach(() => {
  clerkCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    clerkCalls.push({ method: init?.method ?? 'GET', url });
    if (url.endsWith('/revoke')) return Response.json({ id: 'orginv_test', status: 'revoked' });
    if (url.endsWith('/invitations')) return Response.json({ id: `orginv_${clerkCalls.length}` });
    return Response.json({}, { status: 404 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function invite(email: string) {
  const t = createTestApp('/api/team-members', teamMembersRoutes, {
    context: { tenantDb: db, permissions: permissions('team:create') },
  });
  return t.request('/api/team-members/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: 'Back Again' }),
  });
}

describe('POST /invite with soft-deleted rows', () => {
  it('re-invites an address whose earlier invite was cancelled', async () => {
    const res = await invite('back@example.com');
    expect(res.status).toBe(201);

    // Every row on the placeholder, deleted ones included: only the new invite.
    const holders = await db
      .select({ status: workspaceMembers.status, deletedAt: workspaceMembers.deletedAt })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, 'invited_back@example.com'));
    expect(holders).toEqual([{ status: 'PENDING', deletedAt: null }]);

    const [old] = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.id, 'wm_old_invite'));
    expect(old?.userId).toBe('removed_wm_old_invite');
    expect(clerkCalls.some((call) => call.url.endsWith('/revoke'))).toBe(false);
  });

  it('leaves a removed member that holds their real user id alone at invite time', async () => {
    const res = await invite('returning@example.com');
    expect(res.status).toBe(201);

    const [removed] = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.id, 'wm_removed'));
    expect(removed?.userId).toBe('user_returning');
  });

  it('revokes the Clerk invitation when the member row cannot be written', async () => {
    const res = await invite('Taken@example.com');
    expect(res.status).toBe(500);

    const revokes = clerkCalls.filter((call) => call.url.endsWith('/revoke'));
    expect(revokes).toHaveLength(1);
    expect(revokes[0]!.method).toBe('POST');
  });
});
