/**
 * `MailAccess` (task C3, design §2/§6): `PostgresMailAccess` wraps `../access.ts`
 * unchanged; `ObjectMailAccess` decides from directory data with the SAME
 * pure rules. The core of this suite proves the two agree, on the same
 * underlying accounts, for the representative scenarios `../access.ts`'s own
 * route tests exercise (shared / private+assigned / private+stranger /
 * admin-no-bypass) — ported here as a direct comparison rather than through a
 * route.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import { principalIsAdmin, type MailPrincipal } from '../access';
import { ObjectMailAccess, PostgresMailAccess, type MailAccess } from './access';
import { buildMailDirectory, type MailDirectoryEntry } from './directory';

const { mailAccounts, workspaceMembers } = schema;

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

async function seedMember(role: string): Promise<string> {
  const userId = generateId('u');
  await db.insert(workspaceMembers).values({ id: generateId('wm'), userId, email: `${userId}@test.dev`, role } as typeof workspaceMembers.$inferInsert);
  return userId;
}

async function seedAccount(data: { isShared: boolean; assignedUserIds?: string[] | null }): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: `${id}@test.dev`, isShared: data.isShared, assignedUserIds: data.assignedUserIds ?? null });
  return id;
}

interface Fixture {
  shared: string;
  privateAssigned: string;
  privateUnassigned: string;
  userAssigned: string;
  userStranger: string;
  userAdmin: string;
}

async function buildFixture(): Promise<Fixture> {
  const userAssigned = await seedMember('MEMBER');
  const userStranger = await seedMember('MEMBER');
  const userAdmin = await seedMember('ADMIN');
  const shared = await seedAccount({ isShared: true });
  const privateAssigned = await seedAccount({ isShared: false, assignedUserIds: [userAssigned] });
  const privateUnassigned = await seedAccount({ isShared: false, assignedUserIds: null });
  return { shared, privateAssigned, privateUnassigned, userAssigned, userStranger, userAdmin };
}

/** `ObjectMailAccess.resolveIsAdmin` resolved the SAME way `PostgresMailAccess.isAdmin()` does (`principalIsAdmin` against the real `workspace_members` row) — this comparison is about the access-decision RULES agreeing, not about query count. */
function objectAccessFor(directory: MailDirectoryEntry, principal: MailPrincipal): MailAccess {
  return new ObjectMailAccess(directory, principal, () => principalIsAdmin(db, principal));
}

describe('PostgresMailAccess vs ObjectMailAccess: same decisions on the same data', () => {
  it.each([
    ['userAssigned', (f: Fixture) => f.userAssigned],
    ['userStranger', (f: Fixture) => f.userStranger],
    ['userAdmin', (f: Fixture) => f.userAdmin],
  ] as const)('%s: canOpen/canManage/accessibleAccountIds/isShared match for every account', async (_label, pickUserId) => {
    const fixture = await buildFixture();
    const directory = await buildMailDirectory(db);
    const principal: MailPrincipal = { kind: 'user', userId: pickUserId(fixture) };

    const postgres = new PostgresMailAccess(db, principal);
    const object = objectAccessFor(directory, principal);

    for (const accountId of [fixture.shared, fixture.privateAssigned, fixture.privateUnassigned]) {
      expect(await object.canOpen(accountId)).toBe(await postgres.canOpen(accountId));
      expect(await object.canManage(accountId)).toBe(await postgres.canManage(accountId));
      expect(await object.isShared(accountId)).toBe(await postgres.isShared(accountId));
    }
    expect(new Set(await object.accessibleAccountIds())).toEqual(new Set(await postgres.accessibleAccountIds()));
    expect(await object.isAdmin()).toBe(await postgres.isAdmin());
  });

  it('a workspace principal (key) matches too: shared only, never admin, never manages', async () => {
    const fixture = await buildFixture();
    const directory = await buildMailDirectory(db);
    const principal: MailPrincipal = { kind: 'workspace', keyId: 'key_1' };

    const postgres = new PostgresMailAccess(db, principal);
    const object = objectAccessFor(directory, principal);

    for (const accountId of [fixture.shared, fixture.privateAssigned, fixture.privateUnassigned]) {
      expect(await object.canOpen(accountId)).toBe(await postgres.canOpen(accountId));
      expect(await object.canManage(accountId)).toBe(await postgres.canManage(accountId));
    }
    expect(await object.isAdmin()).toBe(false);
    expect(await postgres.isAdmin()).toBe(false);
    // The tenant DB has no workspace column (one tenant DB = one workspace),
    // so other tests' shared accounts are visible too — assert membership,
    // not an exact list, and that the two backends still agree with each
    // other on the full set.
    const objectIds = await object.accessibleAccountIds();
    const postgresIds = await postgres.accessibleAccountIds();
    expect(new Set(objectIds)).toEqual(new Set(postgresIds));
    expect(objectIds).toContain(fixture.shared);
    expect(objectIds).not.toContain(fixture.privateAssigned);
    expect(objectIds).not.toContain(fixture.privateUnassigned);
  });

  it('exact expected decisions (not just agreement) for the representative matrix', async () => {
    const fixture = await buildFixture();
    const directory = await buildMailDirectory(db);
    const assigned = objectAccessFor(directory, { kind: 'user', userId: fixture.userAssigned });
    const stranger = objectAccessFor(directory, { kind: 'user', userId: fixture.userStranger });
    const admin = objectAccessFor(directory, { kind: 'user', userId: fixture.userAdmin });

    // Shared: everyone opens it.
    expect(await assigned.canOpen(fixture.shared)).toBe(true);
    expect(await stranger.canOpen(fixture.shared)).toBe(true);
    expect(await admin.canOpen(fixture.shared)).toBe(true);

    // Private, assigned to userAssigned: only they (and nobody else, admin included) open it.
    expect(await assigned.canOpen(fixture.privateAssigned)).toBe(true);
    expect(await stranger.canOpen(fixture.privateAssigned)).toBe(false);
    expect(await admin.canOpen(fixture.privateAssigned)).toBe(false);

    // Private, nobody assigned: falls back to admin/owner only.
    expect(await assigned.canOpen(fixture.privateUnassigned)).toBe(false);
    expect(await stranger.canOpen(fixture.privateUnassigned)).toBe(false);
    expect(await admin.canOpen(fixture.privateUnassigned)).toBe(true);

    // Manage: admin manages everything; an assignee manages only what they can open.
    expect(await admin.canManage(fixture.privateAssigned)).toBe(true);
    expect(await assigned.canManage(fixture.privateUnassigned)).toBe(false);
  });
});

describe('ObjectMailAccess: directory-only behaviour', () => {
  function directoryWith(accounts: MailDirectoryEntry['accounts'], labels: MailDirectoryEntry['labels'] = {}): MailDirectoryEntry {
    return { v: 1, builtAt: 0, accounts, labels };
  }

  function account(overrides: Partial<MailDirectoryEntry['accounts'][number]> = {}): MailDirectoryEntry['accounts'][number] {
    return {
      id: 'acc_1',
      name: 'Test',
      email: 'test@example.com',
      displayName: null,
      provider: 'imap',
      sendProvider: null,
      receiveProvider: null,
      authType: 'password',
      imapHost: null,
      imapPort: null,
      imapSecure: null,
      smtpHost: null,
      smtpPort: null,
      smtpSecure: null,
      syncEnabled: true,
      syncFrequency: null,
      lastSyncAt: null,
      syncStatus: null,
      syncError: null,
      signature: null,
      autoReply: null,
      aiSettings: null,
      forwardingEmail: null,
      dailySendLimit: null,
      sentToday: null,
      storageUsed: null,
      storageLimit: null,
      status: 'active',
      isDefault: null,
      isShared: false,
      assignedUserIds: null,
      externalAccountId: null,
      mailcowSyncedAt: null,
      tags: null,
      customFields: null,
      metadata: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      ...overrides,
    };
  }

  it('account()/accounts()/canOpen() all say no for an id not in the directory', async () => {
    const access = new ObjectMailAccess(directoryWith([]), { kind: 'user', userId: 'u1' }, async () => false);
    expect(await access.account('missing')).toBeNull();
    expect(await access.canOpen('missing')).toBe(false);
    expect(await access.canManage('missing')).toBe(false);
  });

  it('a soft-deleted account in the directory is treated as absent', async () => {
    const acc = account({ id: 'acc_del', isShared: true, deletedAt: '2026-01-02T00:00:00.000Z' });
    const access = new ObjectMailAccess(directoryWith([acc]), { kind: 'user', userId: 'u1' }, async () => false);
    expect(await access.account('acc_del')).toBeNull();
    expect(await access.canOpen('acc_del')).toBe(false);
    expect(await access.accessibleAccountIds()).toEqual([]);
  });

  it('isAdmin() is memoised: the resolver runs once even across several calls', async () => {
    let calls = 0;
    const access = new ObjectMailAccess(directoryWith([]), { kind: 'user', userId: 'u1' }, async () => {
      calls++;
      return true;
    });
    await Promise.all([access.isAdmin(), access.isAdmin(), access.isAdmin()]);
    expect(calls).toBe(1);
  });

  it('isAdmin() is always false for a workspace principal, without calling the resolver', async () => {
    let calls = 0;
    const access = new ObjectMailAccess(directoryWith([]), { kind: 'workspace', keyId: 'key_1' }, async () => {
      calls++;
      return true;
    });
    expect(await access.isAdmin()).toBe(false);
    expect(calls).toBe(0);
  });

  it('labels() defaults to [] for an account with no directory entry', async () => {
    const access = new ObjectMailAccess(directoryWith([], {}), { kind: 'user', userId: 'u1' }, async () => false);
    expect(await access.labels('acc_1')).toEqual([]);
  });

  it('accounts("manage") for a non-admin equals the accounts they can open', async () => {
    const shared = account({ id: 'acc_shared', isShared: true });
    const privateMine = account({ id: 'acc_mine', isShared: false, assignedUserIds: ['u1'] });
    const privateOther = account({ id: 'acc_other', isShared: false, assignedUserIds: ['u2'] });
    const access = new ObjectMailAccess(directoryWith([shared, privateMine, privateOther]), { kind: 'user', userId: 'u1' }, async () => false);
    const open = await access.accounts('open');
    const manage = await access.accounts('manage');
    expect(open.map((a) => a.id).sort()).toEqual(manage.map((a) => a.id).sort());
    expect(open.map((a) => a.id).sort()).toEqual(['acc_mine', 'acc_shared']);
  });

  it('accounts("manage") for an admin is every live account, including ones they cannot open', async () => {
    const shared = account({ id: 'acc_shared', isShared: true });
    const privateOther = account({ id: 'acc_other', isShared: false, assignedUserIds: ['u2'] });
    const access = new ObjectMailAccess(directoryWith([shared, privateOther]), { kind: 'user', userId: 'admin_1' }, async () => true);
    expect((await access.accounts('manage')).map((a) => a.id).sort()).toEqual(['acc_other', 'acc_shared']);
    // But canOpen still respects assignment even for an admin (no bypass).
    expect(await access.canOpen('acc_other')).toBe(false);
  });

  it('accounts("manage") for a workspace principal is always []', async () => {
    const shared = account({ id: 'acc_shared', isShared: true });
    const access = new ObjectMailAccess(directoryWith([shared]), { kind: 'workspace', keyId: 'key_1' }, async () => false);
    expect(await access.accounts('manage')).toEqual([]);
  });
});
