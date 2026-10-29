/**
 * pglite-backed access tests for `GET /api/mail-labels`.
 *
 * Bug fix: without `accountId` the route used to call `listMailLabels(db, {})`
 * with no account scope at all, so it returned every mailbox's labels (and
 * their live message counts) to any caller with `accounts:read` — private
 * mailboxes included. MAIL-003 says mailbox access follows sharing and
 * assignment, so the unified (no `accountId`) list must be scoped to the
 * caller's accessible mailboxes, like the unified mail-messages list already is.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailLabelsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

const { mailAccounts, mailLabels, workspaceMembers } = schema;

const ADMIN = 'user_admin';
const ASSIGNEE = 'user_assignee';
const MEMBER = 'user_member';

let db: Database;
let shared: string;
let privateAssigned: string;

async function seedMember(userId: string, role: string) {
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId,
    email: `${userId}@test.dev`,
    role,
  } as typeof workspaceMembers.$inferInsert);
}

async function seedAccountWithLabel(name: string, values: Partial<typeof mailAccounts.$inferInsert>) {
  const accountId = generateId('mail');
  await db.insert(mailAccounts).values({ id: accountId, name, email: `${accountId}@test.dev`, ...values });
  await db.insert(mailLabels).values({
    id: generateId('label'),
    accountId,
    name: `${name} label`,
    slug: null,
    isSystem: false,
  } as typeof mailLabels.$inferInsert);
  return accountId;
}

function makeApp(userId: string) {
  return createTestApp('/api/mail-labels', mailLabelsRoutes, {
    context: { userId, tenantDb: db, permissions: permissions('accounts:read') },
  });
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await seedMember(ADMIN, 'ADMIN');
  await seedMember(ASSIGNEE, 'MEMBER');
  await seedMember(MEMBER, 'MEMBER');

  shared = await seedAccountWithLabel('Shared', { isShared: true });
  privateAssigned = await seedAccountWithLabel('Private', { isShared: false, assignedUserIds: [ASSIGNEE] });
}, 60_000);

describe('GET /api/mail-labels without accountId', () => {
  it('never returns a private mailbox\'s labels to a member who is not assigned', async () => {
    const { request } = makeApp(MEMBER);
    const res = await request('/api/mail-labels');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ accountId: string }> };
    expect(body.data.map((l) => l.accountId)).toContain(shared);
    expect(body.data.map((l) => l.accountId)).not.toContain(privateAssigned);
  });

  it('does not widen to every mailbox for an admin either (MAIL-003: role alone never opens it)', async () => {
    const { request } = makeApp(ADMIN);
    const res = await request('/api/mail-labels');
    const body = (await res.json()) as { data: Array<{ accountId: string }> };
    expect(body.data.map((l) => l.accountId)).not.toContain(privateAssigned);
  });

  it('includes the private mailbox for its assignee', async () => {
    const { request } = makeApp(ASSIGNEE);
    const res = await request('/api/mail-labels');
    const body = (await res.json()) as { data: Array<{ accountId: string }> };
    expect(body.data.map((l) => l.accountId)).toContain(privateAssigned);
    expect(body.data.map((l) => l.accountId)).toContain(shared);
  });
});
