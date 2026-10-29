/**
 * pglite-backed tests for `isAdminOrOwner`'s per-db-handle memo (phase 1
 * item 4, docs/plans/weldmail-mailbox-storage.md): a route's own access check
 * and a service it calls (`checkAccountAccess`, then inside it
 * `threadListScope`) can both ask "is this user an admin or owner?" for one
 * request. The memo answers the second ask without a second
 * `workspace_members` round trip, for as long as the caller reuses the same
 * tenant DB handle — which is exactly the lifetime of one request
 * (`packages/core/worker-kit/src/db.ts` builds a fresh handle per request).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { isAdminOrOwner } from './access';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { workspaceMembers } = schema;

let db: Database;

async function seedMember(role: string): Promise<string> {
  const userId = generateId('u');
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId,
    email: `${userId}@test.dev`,
    role,
  } as typeof workspaceMembers.$inferInsert);
  return userId;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('isAdminOrOwner', () => {
  it('answers true for an admin and owner, false for a plain member', async () => {
    const member = await seedMember('MEMBER');
    const admin = await seedMember('ADMIN');
    const owner = await seedMember('OWNER');

    expect(await isAdminOrOwner(db, member)).toBe(false);
    expect(await isAdminOrOwner(db, admin)).toBe(true);
    expect(await isAdminOrOwner(db, owner)).toBe(true);
  });

  it('memoizes per db handle: a role change mid-request does not flip the answer', async () => {
    const userId = await seedMember('MEMBER');

    expect(await isAdminOrOwner(db, userId)).toBe(false);

    await db.update(workspaceMembers).set({ role: 'ADMIN' }).where(eq(workspaceMembers.userId, userId));

    // Same handle as the first call — the memo answers without a second
    // workspace_members lookup, so the role change is invisible to it.
    expect(await isAdminOrOwner(db, userId)).toBe(false);
  });

  it('keeps a separate cached answer per user on the same handle', async () => {
    const member = await seedMember('MEMBER');
    const admin = await seedMember('ADMIN');

    expect(await isAdminOrOwner(db, member)).toBe(false);
    expect(await isAdminOrOwner(db, admin)).toBe(true);
    // Re-asking in the other order still answers correctly — the memo keys
    // on the user, not just "the first answer seen on this handle".
    expect(await isAdminOrOwner(db, admin)).toBe(true);
    expect(await isAdminOrOwner(db, member)).toBe(false);
  });
});
