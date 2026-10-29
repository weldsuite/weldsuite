/**
 * Access-control tests for /api/mail-scheduled/*.
 *
 * `GET /api/mail-scheduled` without an `accountId` used to run an unscoped
 * `mail_messages` query — every scheduled message in the workspace, including
 * a private mailbox the caller cannot open (MAIL-003, the same class of bug
 * already fixed for `/api/mail-labels` and `/api/mail-snooze`). This suite
 * proves the fix in `postgres` mode (the default for every workspace, no
 * `FLAGSHIP` binding needed): the unified list only ever shows mailboxes
 * `access.accessibleAccountIds()` says this caller may open.
 *
 * Runs against a real pglite tenant DB, like the sibling route suites
 * (`mail-snooze/access.test.ts`, `mail-labels/access.test.ts`): the route
 * resolves `workspaceMailFromContext` once per request, which pulls in
 * `@weldsuite/mail-domain/store/directory` — a hand-mocked
 * `@weldsuite/mail-domain/access` throws as soon as the route calls an export
 * the real `MailAccess` needs that the mock never had.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailScheduledRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailMessages, workspaceMembers } = schema;

const USER_ASSIGNED = 'user_assigned';
const USER_STRANGER = 'user_stranger';

let db: Database;
let privateAccountId: string;
let scheduledMessageId: string;

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

  scheduledMessageId = generateId('msg');
  await db.insert(mailMessages).values({
    id: scheduledMessageId,
    accountId: privateAccountId,
    threadId: `thread_${scheduledMessageId}`,
    messageId: `<${scheduledMessageId}@scheduled.weldsuite.org>`,
    from: { email: 'me@test.dev' },
    to: [{ email: 'rcpt@example.com' }],
    subject: 'Later',
    sentDate: new Date(),
    source: 'sent',
    labels: ['SENT', 'SCHEDULED'],
    sendStatus: 'scheduled',
    scheduledFor: new Date(Date.now() + 3_600_000),
  });
}, 60_000);

function makeApp(userId: string) {
  return createTestApp('/api/mail-scheduled', mailScheduledRoutes, {
    context: { userId, tenantDb: db, permissions: permissions('messages:read') },
  });
}

describe('GET /api/mail-scheduled · access control', () => {
  it('returns 403 when accountId is inaccessible', async () => {
    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-scheduled?accountId=${privateAccountId}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 with the row when accountId is accessible', async () => {
    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-scheduled?accountId=${privateAccountId}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ id: string }> };
    expect(json.data.map((m) => m.id)).toEqual([scheduledMessageId]);
  });

  // Bug fix (MAIL-003): the unified list (no `accountId`) must be scoped to
  // the caller's accessible mailboxes, never every mailbox in the workspace —
  // this was unscoped in every mode, including `postgres` (the default),
  // before this fix.
  it("scopes the unified list (no accountId) to the caller's accessible mailboxes", async () => {
    const { request } = makeApp(USER_STRANGER);
    const res = await request('/api/mail-scheduled');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ id: string }> };
    // The stranger has no accessible accounts, so the private mailbox's
    // scheduled mail never appears, even unfiltered.
    expect(json.data).toEqual([]);
  });

  it('includes the private mailbox for its assignee in the unified list', async () => {
    const { request } = makeApp(USER_ASSIGNED);
    const res = await request('/api/mail-scheduled');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ id: string }> };
    expect(json.data.map((m) => m.id)).toContain(scheduledMessageId);
  });
});
