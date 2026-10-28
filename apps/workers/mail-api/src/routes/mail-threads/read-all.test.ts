/**
 * POST /api/mail-threads/read-all — "mark all as read" for a folder.
 *
 * Runs against a real pglite tenant DB (see the sibling `mail-messages/
 * access.test.ts`'s header comment for why: the route now resolves
 * `workspaceMailFromContext`, which imports `@weldsuite/mail-domain/store/
 * directory` — a module that destructures `schema.mailLabels`/`mailAccounts`
 * columns at import time, so this file's old partial `@weldsuite/mail-domain/
 * access` + `thread-ops` mocks threw before any test body ran).
 */

import { beforeAll, describe, expect, it, vi, type MockedFunction } from 'vitest';
import { mailThreadsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

vi.mock('../../lib/read-push', () => ({
  queueMailReadPush: vi.fn(),
}));

import * as readPush from '../../lib/read-push';

const queueMailReadPush = readPush.queueMailReadPush as MockedFunction<typeof readPush.queueMailReadPush>;

const { mailAccounts, mailMessages, workspaceMembers } = schema;

const USER = 'user_1';

let db: Database;
let privateAccountId: string;

async function seedMessage(accountId: string, overrides: Partial<typeof mailMessages.$inferInsert> = {}): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId: `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com' },
    to: [],
    subject: 'Read-all test',
    sentDate: new Date(),
    labels: ['INBOX'],
    isRead: false,
    ...overrides,
  });
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId: USER,
    email: `${USER}@test.dev`,
    role: 'ADMIN',
  } as typeof workspaceMembers.$inferInsert);

  privateAccountId = generateId('mail');
  await db.insert(mailAccounts).values({
    id: privateAccountId,
    name: 'Private',
    email: `${privateAccountId}@test.dev`,
    isShared: false,
    assignedUserIds: [],
  });
}, 60_000);

function makeApp(perms: string[] = ['messages:update']) {
  return createTestApp('/api/mail-threads', mailThreadsRoutes, {
    context: { userId: USER, tenantDb: db, permissions: permissions(...perms) },
  });
}

function readAll(body: unknown, perms?: string[]) {
  return makeApp(perms).request('/api/mail-threads/read-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/mail-threads/read-all', () => {
  it('answers 403 without messages:update', async () => {
    const res = await readAll({ labelSlug: 'inbox', accountId: privateAccountId }, ['messages:read']);
    expect(res.status).toBe(403);
  });

  it('answers 403 for a mailbox the caller may not open', async () => {
    queueMailReadPush.mockClear();
    const otherAccount = generateId('mail');
    await db.insert(mailAccounts).values({
      id: otherAccount,
      name: 'Someone else',
      email: `${otherAccount}@test.dev`,
      isShared: false,
      assignedUserIds: ['user_other'],
    });
    const res = await readAll({ labelSlug: 'inbox', accountId: otherAccount });
    expect(res.status).toBe(403);
    expect(queueMailReadPush).not.toHaveBeenCalled();
  });

  it('answers 400 without a folder', async () => {
    const res = await readAll({ accountId: privateAccountId });
    expect(res.status).toBe(400);
  });

  it('marks one mailbox folder and returns the count', async () => {
    queueMailReadPush.mockClear();
    const m1 = await seedMessage(privateAccountId);
    const m2 = await seedMessage(privateAccountId);

    const res = await readAll({ labelSlug: 'inbox', accountId: privateAccountId });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { updatedCount: number } };
    expect(json.data.updatedCount).toBe(2);
    expect(queueMailReadPush).toHaveBeenCalledWith(
      expect.anything(),
      privateAccountId,
      expect.arrayContaining([m1, m2]),
    );
  });

  it('marks the unified folder without an account-specific check', async () => {
    queueMailReadPush.mockClear();
    const shared = generateId('mail');
    await db.insert(mailAccounts).values({ id: shared, name: 'Shared', email: `${shared}@test.dev`, isShared: true });
    const id = await seedMessage(shared);

    const res = await readAll({ labelSlug: 'inbox' });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { updatedCount: number } };
    expect(json.data.updatedCount).toBeGreaterThanOrEqual(1);
    expect(queueMailReadPush).toHaveBeenCalledWith(expect.anything(), shared, expect.arrayContaining([id]));
  });

  it('pushes at most the 200 newest ids per mailbox', async () => {
    queueMailReadPush.mockClear();
    const bigAccount = generateId('mail');
    await db.insert(mailAccounts).values({ id: bigAccount, name: 'Big', email: `${bigAccount}@test.dev`, isShared: true });
    for (let i = 0; i < 205; i++) await seedMessage(bigAccount);

    const res = await readAll({ labelSlug: 'inbox', accountId: bigAccount });

    expect(res.status).toBe(200);
    const pushed = new Map(queueMailReadPush.mock.calls.map(([, accountId, ids]) => [accountId, ids]));
    expect(pushed.get(bigAccount)?.length).toBeLessThanOrEqual(200);
  });
});
