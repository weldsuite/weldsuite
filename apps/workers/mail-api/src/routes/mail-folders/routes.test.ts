/**
 * /api/mail-folders against a pglite tenant DB: list, detail, create,
 * update (system folders keep their identity) and delete, per mailbox access.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailFoldersRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { MEMBER, PRIVATE, SHARED, STRANGER, seedMailboxes, seedMembers } from '../../test/mail-seed';

const ALL = ['accounts:read', 'accounts:create', 'accounts:update', 'accounts:delete'];

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedMembers(db);
  await seedMailboxes(db);
  const at = new Date('2026-03-01T09:00:00.000Z');
  await db.insert(schema.mailFolders).values([
    { id: 'mfld_seed_inbox', accountId: SHARED, name: 'INBOX', type: 'inbox', isSystem: true, position: 0, createdAt: at, updatedAt: at },
    { id: 'mfld_seed_work', accountId: PRIVATE, name: 'Work', type: 'custom', position: 1, createdAt: at, updatedAt: at },
  ] as never);
}, 60_000);

function as(userId: string, keys: string[] = ALL) {
  const { request } = createTestApp('/api/mail-folders', mailFoldersRoutes, {
    context: { userId, tenantDb: db, permissions: permissions(...keys) },
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/mail-folders${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

describe('mail folders', () => {
  it('reads with access checks', async () => {
    const member = as(MEMBER);
    expect((await member('GET', '')).status).toBe(200);
    expect((await member('GET', `?accountId=${PRIVATE}`)).status).toBe(200);
    expect((await as(STRANGER)('GET', `?accountId=${PRIVATE}`)).status).toBe(403);
    expect((await member('GET', '/mfld_seed_work')).status).toBe(200);
    expect((await as(STRANGER)('GET', '/mfld_seed_work')).status).toBe(403);
    expect((await member('GET', '/mfld_missing')).status).toBe(404);
  });

  it('creates, updates and deletes', async () => {
    const member = as(MEMBER);
    const created = await member('POST', '', { accountId: SHARED, name: 'Receipts', color: '#ff0000', position: 4 });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await member('POST', '', { accountId: SHARED, name: 'Bad', type: 'weird' })).status).toBe(400);
    expect((await member('POST', '', { accountId: SHARED, name: 'Bad', color: '#ff00ff00' })).status).toBe(400);
    expect((await as(STRANGER)('POST', '', { accountId: PRIVATE, name: 'Mine' })).status).toBe(403);

    expect((await member('PATCH', `/${id}`, { name: 'Bills', icon: 'receipt' })).status).toBe(200);
    expect((await member('PUT', `/${id}`, { type: 'archive', path: 'Archive/Bills' })).status).toBe(200);
    expect((await member('PATCH', '/mfld_seed_inbox', { name: 'Box' })).status).toBe(403);
    expect((await member('PATCH', '/mfld_seed_inbox', { color: '#00ff00' })).status).toBe(200);
    expect((await member('PATCH', '/mfld_missing', { name: 'x' })).status).toBe(404);
    expect((await as(STRANGER)('PATCH', '/mfld_seed_work', { name: 'x' })).status).toBe(403);

    expect((await member('DELETE', '/mfld_seed_inbox')).status).toBe(403);
    expect((await member('DELETE', `/${id}`)).status).toBe(204);
    expect((await member('DELETE', `/${id}`)).status).toBe(404);
  });
});
