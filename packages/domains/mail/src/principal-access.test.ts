/**
 * Mailbox access for principals that are not a person.
 *
 * The public API accepts workspace keys and WeldApp tokens, which act as the
 * workspace (`{ kind: 'workspace' }`). Those must reach shared mailboxes only:
 * not a private one, not even a private one with nobody assigned (the
 * admin/owner fallback is for people). A user principal keeps the platform
 * rules unchanged.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  accessibleAccountIds,
  canOpenAccount,
  principalFromSession,
  type MailPrincipal,
} from './access';
import { getPublicMailAccount, listPublicMailAccounts } from './accounts';
import { listThreadsByLabel, getThreadByKey } from './threads';
import { listDrafts } from './drafts';
import { listMailLabels } from './labels';
import { listFolders } from './folders';

const { mailAccounts, mailMessages, mailDrafts, mailLabels, mailFolders, mailDomains, workspaceMembers } = schema;

const WORKSPACE: MailPrincipal = { kind: 'workspace', keyId: 'key_ws' };
const OWNER = 'user_owner';
const ASSIGNEE = 'user_assignee';
const MEMBER = 'user_member';

let db: Database;
let shared: string;
let privateAssigned: string;
let privateUnassigned: string;

async function seedAccount(email: string, fields: Partial<typeof mailAccounts.$inferInsert>): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: email, email, ...fields });
  return id;
}

async function seedMessage(accountId: string, subject: string): Promise<string> {
  const id = generateId('msg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com' },
    to: [{ email: 'rcpt@example.com' }],
    subject,
    labels: ['INBOX'],
    sentDate: new Date(),
  });
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(workspaceMembers).values([
    { id: generateId('wm'), userId: OWNER, email: 'owner@test.dev', role: 'OWNER' },
    { id: generateId('wm'), userId: ASSIGNEE, email: 'assignee@test.dev', role: 'MEMBER' },
    { id: generateId('wm'), userId: MEMBER, email: 'member@test.dev', role: 'MEMBER' },
  ] as (typeof workspaceMembers.$inferInsert)[]);

  shared = await seedAccount('team@verified.dev', { isShared: true });
  privateAssigned = await seedAccount('alice@verified.dev', { isShared: false, assignedUserIds: [ASSIGNEE] });
  privateUnassigned = await seedAccount('nobody@gmail.com', { isShared: false, assignedUserIds: [] });

  await db.insert(mailDomains).values({ id: generateId('mdom'), domainName: 'Verified.dev', dnsStatus: 'verified' });

  for (const accountId of [shared, privateAssigned, privateUnassigned]) {
    await seedMessage(accountId, `hello from ${accountId}`);
    await db.insert(mailDrafts).values({ id: generateId('draft'), accountId, subject: 'draft' });
    await db.insert(mailLabels).values({ id: generateId('label'), accountId, name: `label-${accountId}` });
    await db.insert(mailFolders).values({ id: generateId('mfld'), accountId, name: `folder-${accountId}` });
  }
}, 60_000);

describe('principalFromSession', () => {
  it('acts as the user only when the session carries one', () => {
    expect(principalFromSession({ userId: 'u1', keyId: 'k1' })).toEqual({ kind: 'user', userId: 'u1' });
    expect(principalFromSession({ userId: null, keyId: 'k1' })).toEqual({ kind: 'workspace', keyId: 'k1' });
  });
});

describe('workspace principal', () => {
  it('reaches shared mailboxes only', async () => {
    expect(await accessibleAccountIds(db, WORKSPACE)).toEqual([shared]);
    expect(await canOpenAccount(db, shared, WORKSPACE)).toBe(true);
    expect(await canOpenAccount(db, privateAssigned, WORKSPACE)).toBe(false);
    // The admin fallback for a private mailbox with nobody assigned is for people.
    expect(await canOpenAccount(db, privateUnassigned, WORKSPACE)).toBe(false);
  });

  it('lists and threads stay inside shared mailboxes', async () => {
    const { threads } = await listThreadsByLabel(db, WORKSPACE, { labelSlug: 'inbox' });
    expect(new Set(threads.map((t) => t.accountId))).toEqual(new Set([shared]));

    const single = await listThreadsByLabel(db, WORKSPACE, { labelSlug: 'inbox', accountId: privateAssigned });
    expect(single.threads).toHaveLength(0);
  });

  it('account listing returns the safe projection, never credentials', async () => {
    const { data } = await listPublicMailAccounts(db, WORKSPACE, {});
    expect(data.map((a) => a.id)).toEqual([shared]);
    const keys = Object.keys(data[0]!);
    for (const secret of ['accessToken', 'refreshToken', 'apiKey', 'passwordHash']) {
      expect(keys).not.toContain(secret);
    }
    expect(await getPublicMailAccount(db, WORKSPACE, privateAssigned)).toBeNull();
  });
});

describe('user principal (platform rules unchanged)', () => {
  it('the assignee reaches the shared and their own private mailbox', async () => {
    const ids = await accessibleAccountIds(db, ASSIGNEE);
    expect(new Set(ids)).toEqual(new Set([shared, privateAssigned]));
  });

  it('an owner gets the unassigned private mailbox but not an assigned one', async () => {
    const ids = await accessibleAccountIds(db, { kind: 'user', userId: OWNER });
    expect(new Set(ids)).toEqual(new Set([shared, privateUnassigned]));
  });

  it('a plain member reaches only the shared mailbox', async () => {
    expect(await accessibleAccountIds(db, MEMBER)).toEqual([shared]);
  });
});

describe('account-scoped lists', () => {
  it('drafts, labels and folders honour accessibleAccountIds, and an empty scope matches nothing', async () => {
    const scope = [shared];
    const drafts = await listDrafts(db, { accessibleAccountIds: scope });
    expect(drafts.data.map((d) => d.accountId)).toEqual([shared]);
    expect(drafts.totalCount).toBe(1);

    const labels = await listMailLabels(db, { accessibleAccountIds: scope });
    expect(labels.map((l) => l.accountId)).toEqual([shared]);

    const folders = await listFolders(db, undefined, scope);
    expect(folders.map((f) => f.accountId)).toEqual([shared]);

    expect((await listDrafts(db, { accessibleAccountIds: [] })).data).toHaveLength(0);
    expect(await listMailLabels(db, { accessibleAccountIds: [] })).toHaveLength(0);
  });

  it('canSendViaApi follows the verified domain, case-insensitively', async () => {
    const { data } = await listPublicMailAccounts(db, ASSIGNEE, {});
    const byId = new Map(data.map((a) => [a.id, a.canSendViaApi]));
    expect(byId.get(shared)).toBe(true);
    expect(byId.get(privateAssigned)).toBe(true);
  });
});

describe('getThreadByKey', () => {
  it('returns a threadless message as a thread of one, keyed by its id', async () => {
    const id = await seedMessage(shared, 'single');
    const thread = await getThreadByKey(db, shared, id);
    expect(thread?.messages.map((m) => m.id)).toEqual([id]);
    expect(await getThreadByKey(db, privateAssigned, id)).toBeNull();
  });
});
