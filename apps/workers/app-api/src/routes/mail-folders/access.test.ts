/**
 * Access-control tests for /api/mail-folders/*.
 *
 * Verifies that a user without access to a private mail account receives 403
 * on every folder endpoint for that account, while an assigned user succeeds.
 */

import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import { mailFoldersRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';

vi.mock('../../services/mail/access', () => ({
  checkAccountAccess: vi.fn(),
}));

vi.mock('../../services/mail/folders', () => ({
  listFolders: vi.fn(),
  getFolder: vi.fn(),
  createFolder: vi.fn(),
  updateFolder: vi.fn(),
  softDeleteFolder: vi.fn(),
  MailFolderError: class MailFolderError extends Error {
    constructor(public readonly code: string, msg: string) { super(msg); }
  },
}));

import * as access from '../../services/mail/access';
import * as folders from '../../services/mail/folders';

const checkAccountAccess = access.checkAccountAccess as MockedFunction<typeof access.checkAccountAccess>;
const listFolders = folders.listFolders as MockedFunction<typeof folders.listFolders>;
const getFolder = folders.getFolder as MockedFunction<typeof folders.getFolder>;
const createFolder = folders.createFolder as MockedFunction<typeof folders.createFolder>;

const ACCOUNT_ID = 'acc_private';
const FOLDER_ID = 'mfld_001';

function makeApp(userId: string) {
  return createTestApp('/api/mail-folders', mailFoldersRoutes, {
    context: {
      userId,
      permissions: permissions('accounts:read', 'accounts:create', 'accounts:update', 'accounts:delete'),
    },
  });
}

describe('GET /api/mail-folders · access control', () => {
  it('returns 403 when accountId filter is a private inaccessible account', async () => {
    checkAccountAccess.mockResolvedValueOnce(false);
    const { request } = makeApp('user_stranger');
    const res = await request(`/api/mail-folders?accountId=${ACCOUNT_ID}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 when accountId is accessible', async () => {
    checkAccountAccess.mockResolvedValueOnce(true);
    listFolders.mockResolvedValueOnce([]);
    const { request } = makeApp('user_assigned');
    const res = await request(`/api/mail-folders?accountId=${ACCOUNT_ID}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/mail-folders/:id · access control', () => {
  it('returns 403 when folder belongs to an inaccessible account', async () => {
    getFolder.mockResolvedValueOnce({ id: FOLDER_ID, accountId: ACCOUNT_ID, name: 'Inbox', type: 'inbox' } as never);
    checkAccountAccess.mockResolvedValueOnce(false);
    const { request } = makeApp('user_stranger');
    const res = await request(`/api/mail-folders/${FOLDER_ID}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 for an assigned user', async () => {
    getFolder.mockResolvedValueOnce({ id: FOLDER_ID, accountId: ACCOUNT_ID, name: 'Inbox', type: 'inbox' } as never);
    checkAccountAccess.mockResolvedValueOnce(true);
    const { request } = makeApp('user_assigned');
    const res = await request(`/api/mail-folders/${FOLDER_ID}`);
    expect(res.status).toBe(200);
  });
});

describe('POST /api/mail-folders · access control', () => {
  it('returns 403 when accountId is inaccessible', async () => {
    checkAccountAccess.mockResolvedValueOnce(false);
    const { request } = makeApp('user_stranger');
    const res = await request('/api/mail-folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, name: 'Custom' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 201 for an assigned user', async () => {
    checkAccountAccess.mockResolvedValueOnce(true);
    createFolder.mockResolvedValueOnce({ id: 'mfld_new', accountId: ACCOUNT_ID, name: 'Custom', type: 'custom' } as never);
    const { request } = makeApp('user_assigned');
    const res = await request('/api/mail-folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, name: 'Custom' }),
    });
    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/mail-folders/:id · access control', () => {
  it('returns 403 when folder belongs to an inaccessible account', async () => {
    getFolder.mockResolvedValueOnce({ id: FOLDER_ID, accountId: ACCOUNT_ID, name: 'X', type: 'custom', isSystem: false } as never);
    checkAccountAccess.mockResolvedValueOnce(false);
    const { request } = makeApp('user_stranger');
    const res = await request(`/api/mail-folders/${FOLDER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(403);
  });
});
