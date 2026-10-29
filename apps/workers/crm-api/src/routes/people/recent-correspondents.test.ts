/**
 * pglite-backed access tests for `GET /api/people/recent-correspondents`.
 *
 * Bug fix: the route used to pass a caller-supplied `accountId` straight to
 * `listRecentCorrespondents`, which reads that mailbox's message history,
 * without checking whether the caller may open that mailbox. MAIL-003
 * (mailbox access follows sharing and assignment, `@weldsuite/mail-domain/
 * access`) applies here exactly as it does inside mail-api: a private
 * mailbox's correspondents must not leak to a caller who isn't assigned to
 * it, the admin/owner role included.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { peopleRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

const { mailAccounts, mailMessages, people, workspaceMembers } = schema;

const ADMIN = 'user_admin';
const ASSIGNEE = 'user_assignee';
const MEMBER = 'user_member';

let db: Database;
let privateAccountId: string;

function makeApp(userId: string) {
  return createTestApp('/api/people', peopleRoutes, {
    context: { userId, tenantDb: db, permissions: permissions('people:read') },
  });
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await db.insert(workspaceMembers).values([
    { id: generateId('wm'), userId: ADMIN, email: `${ADMIN}@test.dev`, role: 'ADMIN' },
    { id: generateId('wm'), userId: ASSIGNEE, email: `${ASSIGNEE}@test.dev`, role: 'MEMBER' },
    { id: generateId('wm'), userId: MEMBER, email: `${MEMBER}@test.dev`, role: 'MEMBER' },
  ] as (typeof workspaceMembers.$inferInsert)[]);

  await db.insert(people).values({
    id: generateId('person'),
    displayName: 'Jane Correspondent',
    email: 'jane@example.com',
  });

  privateAccountId = generateId('mail');
  await db.insert(mailAccounts).values({
    id: privateAccountId,
    name: 'Private',
    email: `${privateAccountId}@test.dev`,
    isShared: false,
    assignedUserIds: [ASSIGNEE],
  });
  await db.insert(mailMessages).values({
    id: generateId('mmsg'),
    accountId: privateAccountId,
    threadId: 'thread_1',
    messageId: '<thread_1@test.dev>',
    from: { email: 'jane@example.com', name: 'Jane' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Private correspondence',
    sentDate: new Date(),
    labels: ['INBOX'],
  });
}, 60_000);

describe('GET /api/people/recent-correspondents', () => {
  it('refuses a member who is not assigned to the private mailbox', async () => {
    const { request } = makeApp(MEMBER);
    const res = await request(`/api/people/recent-correspondents?accountId=${privateAccountId}`);
    expect(res.status).toBe(403);
  });

  it('refuses an admin who is not assigned either (MAIL-003: role alone never opens it)', async () => {
    const { request } = makeApp(ADMIN);
    const res = await request(`/api/people/recent-correspondents?accountId=${privateAccountId}`);
    expect(res.status).toBe(403);
  });

  it('answers the mailbox\'s assignee', async () => {
    const { request } = makeApp(ASSIGNEE);
    const res = await request(`/api/people/recent-correspondents?accountId=${privateAccountId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ email: string | null }> };
    expect(body.data.map((p) => p.email)).toContain('jane@example.com');
  });

  it('still answers the tenant-wide fallback when accountId is omitted', async () => {
    const { request } = makeApp(MEMBER);
    const res = await request('/api/people/recent-correspondents');
    expect(res.status).toBe(200);
  });
});
