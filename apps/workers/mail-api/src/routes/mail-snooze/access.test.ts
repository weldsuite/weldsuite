/**
 * Access-control tests for /api/mail-snooze/*.
 *
 * All mutation endpoints carry accountId in the URL path — verifies that the
 * access gate fires before the snooze op is applied.
 *
 * Runs against a real pglite tenant DB, like the sibling route suites
 * (`mail-messages/access.test.ts`, `mail-attachments/access.test.ts`,
 * `mail-labels/access.test.ts`): the route resolves `workspaceMailFromContext`
 * once per request, which imports `@weldsuite/mail-domain/store/directory` —
 * destructuring `schema.mailLabels`/`mailAccounts` columns at import time, so
 * this file's old partial `@weldsuite/mail-domain/access` mock (only
 * `checkAccountAccess`/`accessibleAccountIds`) threw as soon as the route
 * called a different export (`canOpenAccount`, `principalAccessCondition`,
 * …) the real `MailAccess` needs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailSnoozeRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailMessages, workspaceMembers } = schema;

const USER_ASSIGNED = 'user_assigned';
const USER_STRANGER = 'user_stranger';
const UNTIL = new Date(Date.now() + 3_600_000).toISOString();

let db: Database;
let privateAccountId: string;
let messageId: string;

async function seedMember(userId: string, role: string) {
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId,
    email: `${userId}@test.dev`,
    role,
  } as typeof workspaceMembers.$inferInsert);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedMember(USER_ASSIGNED, 'MEMBER');
  await seedMember(USER_STRANGER, 'MEMBER');

  privateAccountId = generateId('mail');
  await db.insert(mailAccounts).values({
    id: privateAccountId,
    name: 'Private',
    email: `${privateAccountId}@test.dev`,
    isShared: false,
    assignedUserIds: [USER_ASSIGNED],
  });

  messageId = generateId('mmsg');
  await db.insert(mailMessages).values({
    id: messageId,
    accountId: privateAccountId,
    threadId: `thread_${messageId}`,
    messageId: `<${messageId}@test.dev>`,
    from: { email: 'sender@example.com' },
    to: [],
    subject: 'Snoozable',
    sentDate: new Date(),
    labels: ['INBOX'],
  });
}, 60_000);

function makeApp(userId: string) {
  return createTestApp('/api/mail-snooze', mailSnoozeRoutes, {
    context: { userId, tenantDb: db, permissions: permissions('messages:read', 'messages:update') },
  });
}

describe('POST /api/mail-snooze/accounts/:accountId/messages/:messageId/snooze · access control', () => {
  it('returns 403 for a user without account access', async () => {
    const { request } = makeApp(USER_STRANGER);
    const res = await request(
      `/api/mail-snooze/accounts/${privateAccountId}/messages/${messageId}/snooze`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ until: UNTIL }) },
    );
    expect(res.status).toBe(403);
  });

  it('returns 200 for an assigned user', async () => {
    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(
      `/api/mail-snooze/accounts/${privateAccountId}/messages/${messageId}/snooze`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ until: UNTIL }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string; snoozedUntil: string } };
    expect(json.data.id).toBe(messageId);
  });
});

describe('POST /api/mail-snooze/accounts/:accountId/messages/:messageId/unsnooze · access control', () => {
  it('returns 403 for a stranger', async () => {
    const { request } = makeApp(USER_STRANGER);
    const res = await request(
      `/api/mail-snooze/accounts/${privateAccountId}/messages/${messageId}/unsnooze`,
      { method: 'POST' },
    );
    expect(res.status).toBe(403);
  });
});

describe('GET /api/mail-snooze/snoozed · access control', () => {
  it('returns 403 when accountId is inaccessible', async () => {
    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-snooze/snoozed?accountId=${privateAccountId}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 when accountId is accessible', async () => {
    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-snooze/snoozed?accountId=${privateAccountId}`);
    expect(res.status).toBe(200);
  });

  // Bug fix (MAIL-003, already landed): the unified list (no `accountId`) must
  // be scoped to the caller's accessible mailboxes, never every mailbox in the
  // workspace.
  it("scopes the unified list (no accountId) to the caller's accessible mailboxes", async () => {
    const { request } = makeApp(USER_STRANGER);
    const res = await request('/api/mail-snooze/snoozed');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ id: string }> };
    // The stranger has no accessible accounts, so the private mailbox's
    // snoozed mail never appears, even unfiltered.
    expect(json.data).toEqual([]);
  });
});
