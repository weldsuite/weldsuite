/**
 * Access-control tests for /api/mail-snooze/*.
 *
 * All mutation endpoints carry accountId in the URL path — verifies that the
 * access gate fires before the snooze service is called.
 */

import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import { mailSnoozeRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';

vi.mock('../../services/mail/access', () => ({
  checkAccountAccess: vi.fn(),
}));

vi.mock('../../services/mail/snooze', () => ({
  listSnoozedMessages: vi.fn(),
  snoozeMessage: vi.fn(),
  unsnoozeMessage: vi.fn(),
  resnoozeMessage: vi.fn(),
  MailSnoozeError: class MailSnoozeError extends Error {
    constructor(public readonly code: string, msg: string) { super(msg); }
  },
}));

import * as access from '../../services/mail/access';
import * as snooze from '../../services/mail/snooze';

const checkAccountAccess = access.checkAccountAccess as MockedFunction<typeof access.checkAccountAccess>;
const snoozeMessage = snooze.snoozeMessage as MockedFunction<typeof snooze.snoozeMessage>;
const unsnoozeMessage = snooze.unsnoozeMessage as MockedFunction<typeof snooze.unsnoozeMessage>;

const ACCOUNT_ID = 'acc_private';
const MESSAGE_ID = 'msg_001';
const UNTIL = new Date(Date.now() + 3_600_000).toISOString();

function makeApp(userId: string) {
  return createTestApp('/api/mail-snooze', mailSnoozeRoutes, {
    context: {
      userId,
      permissions: permissions('messages:read', 'messages:update'),
    },
  });
}

describe('POST /api/mail-snooze/accounts/:accountId/messages/:messageId/snooze · access control', () => {
  it('returns 403 for a user without account access', async () => {
    checkAccountAccess.mockResolvedValueOnce(false);
    const { request } = makeApp('user_stranger');
    const res = await request(
      `/api/mail-snooze/accounts/${ACCOUNT_ID}/messages/${MESSAGE_ID}/snooze`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: UNTIL }),
      },
    );
    expect(res.status).toBe(403);
    expect(snoozeMessage).not.toHaveBeenCalled();
  });

  it('returns 200 for an assigned user', async () => {
    checkAccountAccess.mockResolvedValueOnce(true);
    snoozeMessage.mockResolvedValueOnce({ id: MESSAGE_ID, snoozedUntil: UNTIL } as never);
    const { request } = makeApp('user_assigned');
    const res = await request(
      `/api/mail-snooze/accounts/${ACCOUNT_ID}/messages/${MESSAGE_ID}/snooze`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: UNTIL }),
      },
    );
    expect(res.status).toBe(200);
  });
});

describe('POST /api/mail-snooze/accounts/:accountId/messages/:messageId/unsnooze · access control', () => {
  it('returns 403 for a stranger', async () => {
    checkAccountAccess.mockResolvedValueOnce(false);
    const { request } = makeApp('user_stranger');
    const res = await request(
      `/api/mail-snooze/accounts/${ACCOUNT_ID}/messages/${MESSAGE_ID}/unsnooze`,
      { method: 'POST' },
    );
    expect(res.status).toBe(403);
    expect(unsnoozeMessage).not.toHaveBeenCalled();
  });
});

describe('GET /api/mail-snooze/snoozed · access control', () => {
  it('returns 403 when accountId is inaccessible', async () => {
    checkAccountAccess.mockResolvedValueOnce(false);
    const { request } = makeApp('user_stranger');
    const res = await request(`/api/mail-snooze/snoozed?accountId=${ACCOUNT_ID}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 when accountId is accessible', async () => {
    checkAccountAccess.mockResolvedValueOnce(true);
    (snooze.listSnoozedMessages as MockedFunction<typeof snooze.listSnoozedMessages>).mockResolvedValueOnce([]);
    const { request } = makeApp('user_assigned');
    const res = await request(`/api/mail-snooze/snoozed?accountId=${ACCOUNT_ID}`);
    expect(res.status).toBe(200);
  });
});
