/**
 * /api/mail-sync against a pglite tenant DB: the sync triggers and the sync
 * status, per mailbox access.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailSyncRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { MEMBER, PRIVATE, SHARED, STRANGER, seedMailboxes, seedMembers } from '../../test/mail-seed';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedMembers(db);
  await seedMailboxes(db);
}, 60_000);

function as(userId: string) {
  const { request } = createTestApp('/api/mail-sync', mailSyncRoutes, {
    context: { userId, tenantDb: db, permissions: permissions('accounts:read', 'accounts:update') },
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/mail-sync/accounts${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

describe('mail sync', () => {
  it('triggers syncs and reads and sets the status', async () => {
    const member = as(MEMBER);
    expect((await member('GET', `/${SHARED}/sync-status`)).status).toBe(200);
    expect((await member('POST', `/${SHARED}/sync-messages`)).status).toBe(200);
    expect((await member('POST', `/${SHARED}/sync-messages?label=sent`)).status).toBe(200);
    expect((await member('POST', `/${SHARED}/full-sync`)).status).toBe(200);
    expect((await member('POST', `/${SHARED}/force-resync`, { label: 'archive' })).status).toBe(200);
    expect((await member('POST', `/${SHARED}/force-resync`, {})).status).toBe(200);
    expect((await member('PATCH', `/${SHARED}/sync-status`, { status: 'error', errorMessage: 'IMAP down' })).status).toBe(200);
    expect((await member('PATCH', `/${SHARED}/sync-status`, { status: 'idle' })).status).toBe(200);
    expect((await member('GET', `/${SHARED}/sync-status`)).status).toBe(200);
    expect((await member('PATCH', `/${SHARED}/sync-status`, { status: 'paused' })).status).toBe(400);

    const stranger = as(STRANGER);
    expect((await stranger('GET', `/${PRIVATE}/sync-status`)).status).toBe(403);
    expect((await stranger('POST', `/${PRIVATE}/full-sync`)).status).toBe(403);
    expect((await stranger('POST', `/${PRIVATE}/sync-messages`)).status).toBe(403);
    expect((await stranger('POST', `/${PRIVATE}/force-resync`, {})).status).toBe(403);
    expect((await stranger('PATCH', `/${PRIVATE}/sync-status`, { status: 'idle' })).status).toBe(403);
    expect((await member('GET', '/mail_missing/sync-status')).status).toBe(403);
  });
});
