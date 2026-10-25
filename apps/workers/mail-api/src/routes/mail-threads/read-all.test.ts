/**
 * POST /api/mail-threads/read-all — "mark all as read" for a folder.
 *
 * Route layer only: the access gate, what reaches the service and the cap on
 * the "email read" push. The SQL is covered by mail-domain's
 * `thread-ops.test.ts`.
 */

import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import { mailThreadsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';

vi.mock('@weldsuite/mail-domain/access', () => ({
  checkAccountAccess: vi.fn(),
}));

vi.mock('@weldsuite/mail-domain/thread-ops', () => ({
  markThreadRead: vi.fn(),
  markFolderRead: vi.fn(),
}));

vi.mock('../../lib/read-push', () => ({
  queueMailReadPush: vi.fn(),
}));

import * as access from '@weldsuite/mail-domain/access';
import * as threadOps from '@weldsuite/mail-domain/thread-ops';
import * as readPush from '../../lib/read-push';

const checkAccountAccess = access.checkAccountAccess as MockedFunction<typeof access.checkAccountAccess>;
const markFolderRead = threadOps.markFolderRead as MockedFunction<typeof threadOps.markFolderRead>;
const queueMailReadPush = readPush.queueMailReadPush as MockedFunction<typeof readPush.queueMailReadPush>;

const USER = 'user_1';

function makeApp(perms: string[] = ['messages:update']) {
  return createTestApp('/api/mail-threads', mailThreadsRoutes, {
    context: { userId: USER, permissions: permissions(...perms) },
  });
}

function readAll(body: unknown, perms?: string[]) {
  return makeApp(perms).request('/api/mail-threads/read-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/mail-threads/read-all', () => {
  it('answers 403 without messages:update', async () => {
    const res = await readAll({ labelSlug: 'inbox', accountId: 'acc_1' }, ['messages:read']);
    expect(res.status).toBe(403);
    expect(markFolderRead).not.toHaveBeenCalled();
  });

  it('answers 403 for a mailbox the caller may not open', async () => {
    checkAccountAccess.mockResolvedValueOnce(false);
    const res = await readAll({ labelSlug: 'inbox', accountId: 'acc_private' });
    expect(res.status).toBe(403);
    expect(markFolderRead).not.toHaveBeenCalled();
  });

  it('answers 400 without a folder', async () => {
    const res = await readAll({ accountId: 'acc_1' });
    expect(res.status).toBe(400);
  });

  it('marks one mailbox folder and returns the count', async () => {
    checkAccountAccess.mockResolvedValueOnce(true);
    markFolderRead.mockResolvedValueOnce({
      updatedCount: 2,
      updated: [
        { id: 'm2', accountId: 'acc_1' },
        { id: 'm1', accountId: 'acc_1' },
      ],
    });

    const res = await readAll({ labelSlug: 'inbox', accountId: 'acc_1' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { updatedCount: 2 } });
    expect(markFolderRead).toHaveBeenCalledWith(expect.anything(), USER, { labelSlug: 'inbox', accountId: 'acc_1' }, { updatedPerAccount: 200 });
    expect(queueMailReadPush).toHaveBeenCalledWith(expect.anything(), 'acc_1', ['m2', 'm1']);
  });

  it('marks the unified folder without an account check', async () => {
    markFolderRead.mockResolvedValueOnce({ updatedCount: 0, updated: [] });

    const res = await readAll({ labelSlug: 'inbox' });

    expect(res.status).toBe(200);
    expect(checkAccountAccess).not.toHaveBeenCalled();
    expect(markFolderRead).toHaveBeenCalledWith(expect.anything(), USER, { labelSlug: 'inbox', accountId: undefined }, { updatedPerAccount: 200 });
    expect(queueMailReadPush).not.toHaveBeenCalled();
  });

  it('pushes at most the 200 newest ids per mailbox', async () => {
    const updated = [
      ...Array.from({ length: 250 }, (_, i) => ({ id: `a${i}`, accountId: 'acc_a' })),
      { id: 'b0', accountId: 'acc_b' },
    ];
    markFolderRead.mockResolvedValueOnce({ updatedCount: updated.length, updated });

    const res = await readAll({ labelSlug: 'inbox' });

    expect(res.status).toBe(200);
    const pushed = new Map(queueMailReadPush.mock.calls.map(([, accountId, ids]) => [accountId, ids]));
    expect(pushed.get('acc_a')).toEqual(updated.slice(0, 200).map((r) => r.id));
    expect(pushed.get('acc_b')).toEqual(['b0']);
  });
});
