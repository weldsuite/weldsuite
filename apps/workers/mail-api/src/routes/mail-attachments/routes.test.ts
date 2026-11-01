/**
 * /api/mail-attachments writes against a pglite tenant DB and a memory bucket
 * (postgres mode): create, update (PUT and PATCH, moving between messages),
 * associate, delete with its stored file, and the refusals of each.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailAttachmentsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { MEMBER, PRIVATE, STRANGER, seedMailboxes, seedMembers, seedMessages } from '../../test/mail-seed';

const ORG = 'org_test_default';
const KEY = `workspaces/${ORG}/mail/attachments/msg/notes.txt`;

let db: Database;
const storage = createMemoryR2();

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await storage.put(KEY, 'notes', { httpMetadata: { contentType: 'text/plain' } });
  await seedMembers(db);
  await seedMailboxes(db);
  await seedMessages(db, [
    { id: 'mmsg_a1', subject: 'With files' },
    { id: 'mmsg_a2', subject: 'Other' },
    { id: 'mmsg_a3', accountId: PRIVATE, subject: 'Private' },
  ]);
  await db.insert(schema.mailAttachments).values([
    { id: 'attach_seed_private', messageId: 'mmsg_a3', fileName: 'private.txt', size: 3 },
    { id: 'attach_seed_upload', messageId: 'mmsg_a2', fileName: 'upload.txt', size: 4 },
  ] as never);
}, 60_000);

function as(userId: string) {
  const { request } = createTestApp<Env, Variables>('/api/mail-attachments', mailAttachmentsRoutes, {
    context: {
      userId,
      tenantDb: db,
      permissions: permissions('messages:read', 'messages:create', 'messages:update', 'messages:delete'),
    },
    env: { STORAGE: storage } as Partial<Env>,
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/mail-attachments${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

describe('attachment writes', () => {
  it('creates, updates, associates and deletes', async () => {
    const member = as(MEMBER);
    const created = await member('POST', '', {
      messageId: 'mmsg_a1',
      fileName: 'notes.txt',
      contentType: 'text/plain',
      size: 5,
      storagePath: KEY,
      isInline: false,
      contentId: 'cid-1',
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await member('POST', '', { messageId: 'mmsg_a1', fileName: 'x', size: 1, storagePath: 'workspaces/org_other/x' })).status).toBe(400);
    expect((await member('POST', '', { messageId: 'mmsg_a1', fileName: 'x', size: -1 })).status).toBe(400);
    expect((await member('POST', '', { messageId: 'mmsg_missing', fileName: 'x', size: 1 })).status).toBe(404);
    expect((await as(STRANGER)('POST', '', { messageId: 'mmsg_a3', fileName: 'x', size: 1 })).status).toBe(403);

    expect((await member('GET', `/${id}/download`)).status).toBe(200);
    expect((await member('PATCH', `/${id}`, { fileName: 'renamed.txt' })).status).toBe(200);
    expect((await member('PUT', `/${id}`, { messageId: 'mmsg_a2', checksum: 'abc' })).status).toBe(200);
    expect((await member('PATCH', `/${id}`, { storagePath: '../escape' })).status).toBe(400);
    expect((await member('PATCH', '/attach_missing', { fileName: 'x' })).status).toBe(404);
    expect((await as(STRANGER)('PATCH', '/attach_seed_private', { fileName: 'x' })).status).toBe(403);

    const moved = await member('POST', '/associate', { messageId: 'mmsg_a1', attachmentIds: ['attach_seed_upload', 'attach_seed_upload', 'attach_missing'] });
    expect((await as(STRANGER)('POST', '/associate', { messageId: 'mmsg_a1', attachmentIds: ['attach_seed_private'] })).status).toBe(200);
    expect(moved.status).toBe(200);
    expect((await member('POST', '/associate', { messageId: 'mmsg_a1', attachmentIds: ['attach_missing'] })).status).toBe(200);
    expect((await member('POST', '/associate', { messageId: 'mmsg_a1', attachmentIds: [] })).status).toBe(400);
    expect((await as(STRANGER)('POST', '/associate', { messageId: 'mmsg_a3', attachmentIds: ['attach_seed_upload'] })).status).toBe(403);

    expect((await as(STRANGER)('DELETE', '/attach_seed_private')).status).toBe(403);
    expect((await member('DELETE', `/${id}`)).status).toBe(204);
    expect((await member('DELETE', `/${id}`)).status).toBe(404);
    expect((await member('GET', `/${id}`)).status).toBe(404);
  });
});
