/**
 * /api/mail-drafts against a pglite tenant DB (postgres mode): list and its
 * cursor, detail, create, update and delete, per mailbox access.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailDraftsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { MEMBER, PRIVATE, SHARED, STRANGER, seedMailboxes, seedMembers } from '../../test/mail-seed';

const ALL = ['messages:read', 'messages:create', 'messages:update', 'messages:delete'];

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedMembers(db);
  await seedMailboxes(db);
  const at = (minutes: number) => new Date(Date.UTC(2026, 2, 1, 9, minutes));
  await db.insert(schema.mailDrafts).values([
    { id: 'draft_seed_1', accountId: SHARED, subject: 'First', updatedAt: at(1), createdAt: at(1) },
    { id: 'draft_seed_2', accountId: SHARED, subject: 'Second', updatedAt: at(2), createdAt: at(2) },
    { id: 'draft_seed_3', accountId: PRIVATE, subject: 'Private', updatedAt: at(3), createdAt: at(3) },
  ] as never);
}, 60_000);

function as(userId: string, keys: string[] = ALL) {
  const { request } = createTestApp('/api/mail-drafts', mailDraftsRoutes, {
    context: { userId, tenantDb: db, permissions: permissions(...keys) },
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/mail-drafts${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

describe('mail drafts', () => {
  it('lists and reads with access checks', async () => {
    const member = as(MEMBER);
    expect((await member('GET', '')).status).toBe(200);
    expect((await member('GET', `?accountId=${SHARED}`)).status).toBe(200);
    const first = await member('GET', '?limit=1');
    const cursor = ((await first.json()) as { pagination: { cursor: string } }).pagination.cursor;
    expect((await member('GET', `?limit=1&cursor=${cursor}`)).status).toBe(200);
    expect((await as(STRANGER)('GET', `?accountId=${PRIVATE}`)).status).toBe(403);
    expect((await member('GET', '?limit=500')).status).toBe(400);
    expect((await member('GET', '/draft_seed_3')).status).toBe(200);
    expect((await as(STRANGER)('GET', '/draft_seed_3')).status).toBe(403);
    expect((await member('GET', '/draft_missing')).status).toBe(404);
  });

  it('creates, updates and deletes', async () => {
    const member = as(MEMBER);
    const created = await member('POST', '', {
      accountId: SHARED,
      subject: 'Hello',
      to: ['a@example.com'],
      body: 'Hi',
      importance: 'high',
      attachmentIds: ['attach_1', 'attach_2'],
      isReply: true,
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await member('POST', '', { accountId: SHARED, importance: 'urgent' })).status).toBe(400);
    expect((await as(STRANGER)('POST', '', { accountId: PRIVATE, subject: 'x' })).status).toBe(403);

    expect((await member('PATCH', `/${id}`, { subject: 'Hello again', attachmentIds: [] })).status).toBe(200);
    expect((await member('PUT', `/${id}`, { cc: ['b@example.com'], labels: ['x'], isForward: true })).status).toBe(200);
    expect((await as(STRANGER)('PATCH', '/draft_seed_3', { subject: 'x' })).status).toBe(403);
    expect((await member('PATCH', '/draft_missing', { subject: 'x' })).status).toBe(404);

    expect((await as(STRANGER)('DELETE', '/draft_seed_3')).status).toBe(403);
    expect((await member('DELETE', `/${id}`)).status).toBe(204);
    expect((await member('DELETE', `/${id}`)).status).toBe(404);
  });
});
