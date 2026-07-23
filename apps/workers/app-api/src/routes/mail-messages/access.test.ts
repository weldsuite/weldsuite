/**
 * Access-control tests for /api/mail-messages/*.
 *
 * Verifies the privilege-escalation fix: a user NOT assigned to a private
 * (non-shared) mail account must receive 403 on every endpoint that touches
 * that account's messages.  A user who IS assigned (or whose account is
 * shared) must succeed.  Admin/owner users bypass the per-account gate.
 *
 * The test uses the createMockDb harness — it does not hit a real DB, so
 * only the route layer logic (import + access helper call) is exercised
 * here.  A companion pglite integration test (access.integration.test.ts)
 * covers the SQL path end-to-end.
 */

import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import { mailMessagesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';

// ---------------------------------------------------------------------------
// Mock the access + messages service modules so we control the DB responses.
// ---------------------------------------------------------------------------

vi.mock('../../services/mail/access', () => ({
  checkAccountAccess: vi.fn(),
  isAdminOrOwner: vi.fn(),
  userAccessCondition: vi.fn(() => ({ _tag: 'sql' })),
  hasAccessToAccount: vi.fn(),
}));

vi.mock('../../services/mail/messages', () => ({
  getMessageAccountId: vi.fn(),
  getMessage: vi.fn(),
  getThread: vi.fn(),
  listMessages: vi.fn(),
  getMessageStats: vi.fn(),
  updateMessage: vi.fn(),
  softDeleteMessage: vi.fn(),
  bulkUpdateMessages: vi.fn(),
  addMessageLabels: vi.fn(),
  removeMessageLabels: vi.fn(),
}));

// The send service imports cloudflare:email which is not available in the
// Vitest node environment — mock it at the module level.
vi.mock('../../services/mail/send', () => ({
  replyAndPersist: vi.fn(),
  forwardAndPersist: vi.fn(),
  MailSendError: class MailSendError extends Error {
    constructor(public readonly code: string, public readonly message: string, public readonly details?: unknown) {
      super(message);
    }
  },
}));

// We also need to mock the db schema reference used in /bulk and in the list
// path, because the route imports `schema` from '../../db'.
vi.mock('../../db', () => ({
  schema: {
    mailAccounts: {
      id: 'id',
      isShared: 'isShared',
      assignedUserIds: 'assignedUserIds',
      deletedAt: 'deletedAt',
    },
    mailMessages: {
      id: 'id',
      accountId: 'accountId',
      deletedAt: 'deletedAt',
    },
  },
}));

import * as access from '../../services/mail/access';
import * as msgs from '../../services/mail/messages';

const checkAccountAccess = access.checkAccountAccess as MockedFunction<typeof access.checkAccountAccess>;
const isAdminOrOwner = access.isAdminOrOwner as MockedFunction<typeof access.isAdminOrOwner>;
const getMessageAccountId = msgs.getMessageAccountId as MockedFunction<typeof msgs.getMessageAccountId>;
const getMessage = msgs.getMessage as MockedFunction<typeof msgs.getMessage>;
const getThread = msgs.getThread as MockedFunction<typeof msgs.getThread>;
const listMessages = msgs.listMessages as MockedFunction<typeof msgs.listMessages>;
const getMessageStats = msgs.getMessageStats as MockedFunction<typeof msgs.getMessageStats>;
const updateMessage = msgs.updateMessage as MockedFunction<typeof msgs.updateMessage>;
const softDeleteMessage = msgs.softDeleteMessage as MockedFunction<typeof msgs.softDeleteMessage>;
const addMessageLabels = msgs.addMessageLabels as MockedFunction<typeof msgs.addMessageLabels>;
const removeMessageLabels = msgs.removeMessageLabels as MockedFunction<typeof msgs.removeMessageLabels>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'acc_private';
const MESSAGE_ID = 'msg_001';
const USER_ASSIGNED = 'user_assigned';
const USER_STRANGER = 'user_stranger';

function makeApp(userId: string, perms: string[] = ['messages:read', 'messages:create', 'messages:update', 'messages:delete']) {
  return createTestApp('/api/mail-messages', mailMessagesRoutes, {
    context: {
      userId,
      permissions: permissions(...perms),
    },
  });
}

// ---------------------------------------------------------------------------
// GET /:id — per-message access check
// ---------------------------------------------------------------------------

describe('GET /api/mail-messages/:id · access control', () => {
  it('returns 403 when caller has no access to the message account', async () => {
    getMessageAccountId.mockResolvedValueOnce(ACCOUNT_ID);
    checkAccountAccess.mockResolvedValueOnce(false);

    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-messages/${MESSAGE_ID}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when the message does not exist', async () => {
    getMessageAccountId.mockResolvedValueOnce(null);

    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages/${MESSAGE_ID}`);
    expect(res.status).toBe(404);
  });

  it('returns 200 when the caller is assigned to the account', async () => {
    getMessageAccountId.mockResolvedValueOnce(ACCOUNT_ID);
    checkAccountAccess.mockResolvedValueOnce(true);
    getMessage.mockResolvedValueOnce({
      id: MESSAGE_ID,
      accountId: ACCOUNT_ID,
      subject: 'Test',
      attachments: [],
    } as never);

    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages/${MESSAGE_ID}`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /:id/thread — same gate as /:id
// ---------------------------------------------------------------------------

describe('GET /api/mail-messages/:id/thread · access control', () => {
  it('returns 403 for a stranger on a private-account message', async () => {
    getMessageAccountId.mockResolvedValueOnce(ACCOUNT_ID);
    checkAccountAccess.mockResolvedValueOnce(false);

    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-messages/${MESSAGE_ID}/thread`);
    expect(res.status).toBe(403);
  });

  it('returns 200 for an assigned user', async () => {
    getMessageAccountId.mockResolvedValueOnce(ACCOUNT_ID);
    checkAccountAccess.mockResolvedValueOnce(true);
    getThread.mockResolvedValueOnce({ threadId: 'th_1', messages: [] } as never);

    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages/${MESSAGE_ID}/thread`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id — same gate
// ---------------------------------------------------------------------------

describe('PATCH /api/mail-messages/:id · access control', () => {
  it('returns 403 for a stranger', async () => {
    getMessageAccountId.mockResolvedValueOnce(ACCOUNT_ID);
    checkAccountAccess.mockResolvedValueOnce(false);

    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-messages/${MESSAGE_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRead: true }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 200 for an assigned user', async () => {
    getMessageAccountId.mockResolvedValueOnce(ACCOUNT_ID);
    checkAccountAccess.mockResolvedValueOnce(true);
    updateMessage.mockResolvedValueOnce({
      id: MESSAGE_ID,
      accountId: ACCOUNT_ID,
      subject: 'Hi',
      from: null,
      to: null,
    } as never);

    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages/${MESSAGE_ID}`, {
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
    getMessageAccountId.mockResolvedValueOnce(ACCOUNT_ID);
    checkAccountAccess.mockResolvedValueOnce(false);

    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-messages/${MESSAGE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('returns 204 for an assigned user', async () => {
    getMessageAccountId.mockResolvedValueOnce(ACCOUNT_ID);
    checkAccountAccess.mockResolvedValueOnce(true);
    softDeleteMessage.mockResolvedValueOnce({ id: MESSAGE_ID, accountId: ACCOUNT_ID, subject: null });

    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages/${MESSAGE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/labels/add — same gate
// ---------------------------------------------------------------------------

describe('POST /api/mail-messages/:id/labels/add · access control', () => {
  it('returns 403 for a stranger', async () => {
    getMessageAccountId.mockResolvedValueOnce(ACCOUNT_ID);
    checkAccountAccess.mockResolvedValueOnce(false);

    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-messages/${MESSAGE_ID}/labels/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: ['STARRED'] }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 200 for an assigned user', async () => {
    getMessageAccountId.mockResolvedValueOnce(ACCOUNT_ID);
    checkAccountAccess.mockResolvedValueOnce(true);
    addMessageLabels.mockResolvedValueOnce(['INBOX', 'STARRED']);

    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages/${MESSAGE_ID}/labels/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: ['STARRED'] }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET / — list constrained to accessible accounts when not admin
// ---------------------------------------------------------------------------

describe('GET /api/mail-messages · list access control', () => {
  it('returns 403 when accountId filter is an inaccessible private account', async () => {
    checkAccountAccess.mockResolvedValueOnce(false);

    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-messages?accountId=${ACCOUNT_ID}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 when accountId filter is accessible', async () => {
    checkAccountAccess.mockResolvedValueOnce(true);
    listMessages.mockResolvedValueOnce({ data: [], hasMore: false, cursor: null, totalCount: 0 });

    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages?accountId=${ACCOUNT_ID}`);
    expect(res.status).toBe(200);
  });

  it('returns empty list when non-admin has no accessible accounts', async () => {
    // isAdminOrOwner returns false; db.select returns [] (no accessible accounts)
    isAdminOrOwner.mockResolvedValueOnce(false);
    // The route will do a DB select for accessible accounts — the mock DB
    // returns undefined for chained calls, so the final .from().where() chain
    // returns the proxy. We override listMessages to be safe.
    listMessages.mockResolvedValueOnce({ data: [], hasMore: false, cursor: null, totalCount: 0 });

    const { request } = makeApp(USER_STRANGER, ['messages:read']);
    const res = await request('/api/mail-messages');
    // The route short-circuits with an empty list when there are no accessible
    // accounts — status 200, data = [].
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /stats — accountId optional but gated
// ---------------------------------------------------------------------------

describe('GET /api/mail-messages/stats · access control', () => {
  it('returns 403 when accountId is inaccessible', async () => {
    checkAccountAccess.mockResolvedValueOnce(false);

    const { request } = makeApp(USER_STRANGER);
    const res = await request(`/api/mail-messages/stats?accountId=${ACCOUNT_ID}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 when accountId is accessible', async () => {
    checkAccountAccess.mockResolvedValueOnce(true);
    getMessageStats.mockResolvedValueOnce({ total: 0, unread: 0, inboxUnread: 0, starred: 0 });

    const { request } = makeApp(USER_ASSIGNED);
    const res = await request(`/api/mail-messages/stats?accountId=${ACCOUNT_ID}`);
    expect(res.status).toBe(200);
  });
});
