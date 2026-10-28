/**
 * Access-control tests for /api/mail-messages/*.
 *
 * Verifies the privilege-escalation fix: a user NOT assigned to a private
 * (non-shared) mail account must receive 403 on every endpoint that touches
 * that account's messages.  A user who IS assigned (or whose account is
 * shared) must succeed.  Admin/owner users get no bypass: the unified list is
 * scoped to the accounts they can open, like everyone else's.
 *
 * Runs against a real pglite tenant DB (`@weldsuite/worker-kit/testing/pglite`)
 * and the real mailbox store (`postgres` mode — the default for every
 * workspace), rather than mocking `@weldsuite/mail-domain/{access,messages}`:
 * the route now resolves `workspaceMailFromContext` once per request and
 * reads/writes through `store`/`access`, which themselves import
 * `@weldsuite/mail-domain/store/directory` — that module destructures
 * `schema.mailLabels`/`schema.mailAccounts` columns at import time, so a
 * test's own partial `schema` mock (as this file used to ship) throws before
 * any test body runs. A real schema sidesteps that entirely and exercises
 * the actual access decision, which is the point of this suite anyway.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mailMessagesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/mail-domain/send', () => ({
  replyAndPersist: vi.fn(),
  forwardAndPersist: vi.fn(),
  MailSendError: class MailSendError extends Error {
    constructor(public readonly code: string, public readonly message: string, public readonly details?: unknown) {
      super(message);
    }
  },
}));

const { mailAccounts, mailMessages, workspaceMembers } = schema;

const USER_ASSIGNED = 'user_assigned';
const USER_STRANGER = 'user_stranger';
const USER_ADMIN = 'user_admin';

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
  await seedMember(USER_ADMIN, 'ADMIN');

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
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Test',
    sentDate: new Date(),
    labels: ['INBOX'],
    isRead: false,
  });
}, 60_000);

function makeApp(userId: string, perms: string[] = ['messages:read', 'messages:create', 'messages:update', 'messages:delete']) {
  return createTestApp('/api/mail-messages', mailMessagesRoutes, {
    context: { userId, tenantDb: db, permissions: permissions(...perms) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /:id — per-message access check
// ---------------------------------------------------------------------------

describe('GET /api/mail-messages/:id · access control', () => {
  it('returns 403 when caller has no access to the message account', async () => {
    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-messages/${messageId}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when the message does not exist', async () => {
    const { request } = makeApp(USER_ASSIGNED);
    const res = await request('/api/mail-messages/msg_does_not_exist');
    expect(res.status).toBe(404);
  });

  it('returns 200 when the caller is assigned to the account', async () => {
    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages/${messageId}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string } };
    expect(json.data.id).toBe(messageId);
  });
});

// ---------------------------------------------------------------------------
// GET /:id/thread — same gate as /:id
// ---------------------------------------------------------------------------

describe('GET /api/mail-messages/:id/thread · access control', () => {
  it('returns 403 for a stranger on a private-account message', async () => {
    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-messages/${messageId}/thread`);
    expect(res.status).toBe(403);
  });

  it('returns 200 for an assigned user', async () => {
    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages/${messageId}/thread`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id — same gate
// ---------------------------------------------------------------------------

describe('PATCH /api/mail-messages/:id · access control', () => {
  it('returns 403 for a stranger', async () => {
    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRead: true }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 200 for an assigned user', async () => {
    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRead: true }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------

describe('DELETE /api/mail-messages/:id · access control', () => {
  it('returns 403 for a stranger', async () => {
    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-messages/${messageId}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('returns 204 for an assigned user', async () => {
    const localId = generateId('mmsg');
    await db.insert(mailMessages).values({
      id: localId,
      accountId: privateAccountId,
      threadId: `thread_${localId}`,
      messageId: `<${localId}@test.dev>`,
      from: { email: 'sender@example.com' },
      to: [],
      subject: 'Deletable',
      sentDate: new Date(),
      labels: ['INBOX'],
      isRead: false,
    });
    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages/${localId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/labels/add — same gate
// ---------------------------------------------------------------------------

describe('POST /api/mail-messages/:id/labels/add · access control', () => {
  it('returns 403 for a stranger', async () => {
    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-messages/${messageId}/labels/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: ['STARRED'] }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 200 for an assigned user', async () => {
    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages/${messageId}/labels/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: ['STARRED'] }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET / — list constrained to accessible accounts, admins included
// ---------------------------------------------------------------------------

describe('GET /api/mail-messages · list access control', () => {
  it('returns 403 when accountId filter is an inaccessible private account', async () => {
    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-messages?accountId=${privateAccountId}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 when accountId filter is accessible', async () => {
    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages?accountId=${privateAccountId}`);
    expect(res.status).toBe(200);
  });

  it('returns empty list when non-admin has no accessible accounts', async () => {
    const { request } = makeApp(USER_STRANGER, ['messages:read']);
    const res = await request('/api/mail-messages');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toEqual([]);
  });

  it("scopes the unified list for an admin too — never a colleague's private mailbox", async () => {
    const { request } = makeApp(USER_ADMIN, ['messages:read']);
    const res = await request('/api/mail-messages');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ accountId: string }> };
    // The admin is not assigned to `privateAccountId`, so its messages never
    // appear in the admin's unified list.
    expect(json.data.every((m) => m.accountId !== privateAccountId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /stats — accountId optional but gated
// ---------------------------------------------------------------------------

describe('GET /api/mail-messages/stats · access control', () => {
  it('returns 403 when accountId is inaccessible', async () => {
    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-messages/stats?accountId=${privateAccountId}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 when accountId is accessible', async () => {
    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages/stats?accountId=${privateAccountId}`);
    expect(res.status).toBe(200);
  });

  it('scopes the unified counters to the accounts the caller can open', async () => {
    const { request } = makeApp(USER_STRANGER, ['messages:read']);
    const res = await request('/api/mail-messages/stats');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { total: number } };
    // The stranger has no accessible accounts at all.
    expect(json.data.total).toBe(0);
  });
});
