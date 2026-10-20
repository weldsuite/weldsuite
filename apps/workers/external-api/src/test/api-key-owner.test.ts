/**
 * Personal API keys die with their owner's membership.
 *
 * A personal `wsk_` key authenticates on its own frozen scopes, so the key row
 * alone says nothing about whether the person is still in the workspace. The
 * live check (`sessionFromTenantKey`, step 3 of key validation) must also find
 * the owner as an ACTIVE, not-deleted `workspace_members` row. Workspace keys
 * belong to the workspace and are not tied to a person.
 *
 * Runs the real queries against pglite; the KV-cached steps before it (registry
 * and workspace lookups) are not under test here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { apiKeys } from '@weldsuite/db/schema/api-keys';
import { workspaceApiKeys } from '@weldsuite/db/schema/workspace-api-keys';
import { workspaceMembers } from '@weldsuite/db/schema/workspace-members';
import { sessionFromTenantKey, loadPersonalKey } from '../middleware/api-key-session';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';

type Registry = Parameters<typeof sessionFromTenantKey>[1];
type Workspace = Parameters<typeof sessionFromTenantKey>[2];

let db: Database;

const memberIds = [
  'wm_ownertest_active',
  'wm_ownertest_removed',
  'wm_ownertest_suspended',
  'wm_ownertest_pending',
  'wm_ownertest_expired',
];
const personalKeyIds = [
  'ak_ownertest_active',
  'ak_ownertest_removed',
  'ak_ownertest_suspended',
  'ak_ownertest_pending',
  'ak_ownertest_nomember',
  'ak_ownertest_revoked',
  'ak_ownertest_expired',
];
const workspaceKeyIds = ['wak_ownertest_orphan'];

const workspace: Workspace = { databaseUrl: 'postgres://tenant', tier: 'business', clerkOrgId: 'org_ownertest' };

function registry(keyType: 'personal' | 'workspace', tenantKeyId: string): Registry {
  return { workspaceId: 'ws_ownertest', keyType, tenantKeyId };
}

function personal(tenantKeyId: string) {
  return sessionFromTenantKey(db, registry('personal', tenantKeyId), workspace, new Date());
}

beforeAll(async () => {
  ({ db } = await createPgliteDb());
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3_600_000);

  await db.insert(workspaceMembers).values([
    { id: memberIds[0]!, userId: 'user_ownertest_active', role: 'MEMBER', status: 'ACTIVE' },
    { id: memberIds[1]!, userId: 'user_ownertest_removed', role: 'MEMBER', status: 'ACTIVE', deletedAt: now },
    { id: memberIds[2]!, userId: 'user_ownertest_suspended', role: 'MEMBER', status: 'SUSPENDED' },
    { id: memberIds[3]!, userId: 'user_ownertest_pending', role: 'MEMBER', status: 'PENDING' },
    { id: memberIds[4]!, userId: 'user_ownertest_expired', role: 'MEMBER', status: 'ACTIVE' },
  ]);

  const key = (id: string, userId: string, extra: Partial<typeof apiKeys.$inferInsert> = {}) => ({
    id,
    name: id,
    keyHash: `hash_${id}`,
    keyPrefix: 'wsk_test',
    userId,
    scopes: ['people:read'],
    ...extra,
  });
  await db.insert(apiKeys).values([
    key('ak_ownertest_active', 'user_ownertest_active'),
    key('ak_ownertest_removed', 'user_ownertest_removed'),
    key('ak_ownertest_suspended', 'user_ownertest_suspended'),
    key('ak_ownertest_pending', 'user_ownertest_pending'),
    // The owner has no member row at all.
    key('ak_ownertest_nomember', 'user_ownertest_ghost'),
    // An active owner, but this key itself is revoked or expired.
    key('ak_ownertest_revoked', 'user_ownertest_active', { deletedAt: now }),
    key('ak_ownertest_expired', 'user_ownertest_expired', { expiresAt: hourAgo }),
  ]);

  // Workspace key created by someone who is no longer a member (no row for them).
  await db.insert(workspaceApiKeys).values({
    id: 'wak_ownertest_orphan',
    name: 'ci',
    keyHash: 'hash_wak_ownertest_orphan',
    keyPrefix: 'wsk_test',
    createdBy: 'user_ownertest_gone',
    scopes: ['*'],
  });
}, 60_000);

afterAll(async () => {
  await db.delete(apiKeys).where(inArray(apiKeys.id, personalKeyIds));
  await db.delete(workspaceApiKeys).where(inArray(workspaceApiKeys.id, workspaceKeyIds));
  await db.delete(workspaceMembers).where(inArray(workspaceMembers.id, memberIds));
});

describe('personal API key owner', () => {
  it('authenticates while its owner is an active member', async () => {
    const session = await personal('ak_ownertest_active');
    expect(session).toMatchObject({
      keyId: 'ak_ownertest_active',
      keyType: 'personal',
      userId: 'user_ownertest_active',
      workspaceId: 'ws_ownertest',
      scopes: ['people:read'],
      clerkOrgId: 'org_ownertest',
    });
  });

  it('is refused once the owner was removed from the workspace', async () => {
    expect(await personal('ak_ownertest_removed')).toBeNull();
  });

  it('is refused while the owner is suspended', async () => {
    expect(await personal('ak_ownertest_suspended')).toBeNull();
  });

  it('is refused while the owner has not accepted the invitation', async () => {
    expect(await personal('ak_ownertest_pending')).toBeNull();
  });

  it('is refused when the owner has no member row', async () => {
    expect(await personal('ak_ownertest_nomember')).toBeNull();
  });

  it('is still refused for a revoked or expired key of an active owner', async () => {
    expect(await personal('ak_ownertest_revoked')).toBeNull();
    expect(await personal('ak_ownertest_expired')).toBeNull();
  });

  it('reads the owner live: suspending then restoring the owner flips the key at once', async () => {
    expect(await personal('ak_ownertest_active')).not.toBeNull();

    await db.update(workspaceMembers).set({ status: 'SUSPENDED' }).where(eq(workspaceMembers.id, 'wm_ownertest_active'));
    expect(await personal('ak_ownertest_active')).toBeNull();

    await db.update(workspaceMembers).set({ status: 'ACTIVE' }).where(eq(workspaceMembers.id, 'wm_ownertest_active'));
    expect(await personal('ak_ownertest_active')).not.toBeNull();

    await db.update(workspaceMembers).set({ deletedAt: new Date() }).where(eq(workspaceMembers.id, 'wm_ownertest_active'));
    expect(await personal('ak_ownertest_active')).toBeNull();

    await db.update(workspaceMembers).set({ deletedAt: null }).where(eq(workspaceMembers.id, 'wm_ownertest_active'));
    expect(await personal('ak_ownertest_active')).not.toBeNull();
  });

  it('does not match a key to some other active member', async () => {
    // user_ownertest_removed's key must not borrow the active member's row.
    expect(await loadPersonalKey(db, 'ak_ownertest_removed', new Date())).toBeNull();
    expect(await loadPersonalKey(db, 'ak_ownertest_active', new Date())).not.toBeNull();
  });
});

describe('workspace API key', () => {
  it('is not tied to a member: it works although its creator is gone', async () => {
    const session = await sessionFromTenantKey(
      db,
      registry('workspace', 'wak_ownertest_orphan'),
      workspace,
      new Date(),
    );
    expect(session).toMatchObject({
      keyId: 'wak_ownertest_orphan',
      keyType: 'workspace',
      userId: null,
      scopes: ['*'],
    });
  });

  it('is still refused when the key id does not exist', async () => {
    expect(await sessionFromTenantKey(db, registry('workspace', 'wak_missing'), workspace, new Date())).toBeNull();
  });
});
