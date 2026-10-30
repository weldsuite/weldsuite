/**
 * /api/mail-rules against a pglite tenant DB: list, CRUD, toggle, copies and
 * reordering, per mailbox access.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailRulesRoutes } from './index';
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
  const { request } = createTestApp('/api/mail-rules', mailRulesRoutes, {
    context: {
      userId,
      tenantDb: db,
      permissions: permissions('accounts:read', 'accounts:create', 'accounts:update', 'accounts:delete'),
    },
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/mail-rules${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const rule = (accountId: string, name: string) => ({
  accountId,
  name,
  conditions: [
    { field: 'from', operator: 'contains', value: 'boss@' },
    { field: 'subject', operator: 'equals', value: ['a', 'b'], ignored: true },
  ],
  actions: [{ type: 'add_label', labelId: 'label_1' }, { type: 'forward_to', email: 'me@example.com' }],
  priority: 2,
});

describe('mail rules', () => {
  it('creates, lists, edits, toggles, copies, reorders and deletes', async () => {
    const member = as(MEMBER);
    const created = await member('POST', '', rule(SHARED, 'Boss'));
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const second = await member('POST', '', { ...rule(PRIVATE, 'Private'), matchType: 'any', scope: 'all', folders: ['INBOX'] });
    const privateId = ((await second.json()) as { data: { id: string } }).data.id;
    expect((await member('POST', '', { ...rule(SHARED, 'Bad'), conditions: [] })).status).toBe(400);
    expect((await member('POST', '', { ...rule(SHARED, 'Bad'), conditions: [{ field: 'from', operator: 'contains', value: 5 }] })).status).toBe(400);
    expect((await member('POST', '', { ...rule(SHARED, 'Bad'), actions: [{ type: 'forward_to', email: 'nope' }] })).status).toBe(400);
    expect((await as(STRANGER)('POST', '', rule(PRIVATE, 'Mine'))).status).toBe(403);

    for (const q of ['', `?accountId=${SHARED}`, '?isActive=true', '?isActive=']) {
      expect((await member('GET', q)).status).toBe(200);
    }
    expect((await as(STRANGER)('GET', `?accountId=${PRIVATE}`)).status).toBe(403);
    expect((await member('GET', `/${id}`)).status).toBe(200);
    expect((await as(STRANGER)('GET', `/${privateId}`)).status).toBe(403);
    expect((await member('GET', '/rule_missing')).status).toBe(404);

    expect((await member('PATCH', `/${id}`, { name: 'Boss mail', stopProcessing: true })).status).toBe(200);
    expect((await member('PUT', `/${id}`, { actions: [{ type: 'star' }], applyToExisting: true })).status).toBe(200);
    expect((await as(STRANGER)('PATCH', `/${privateId}`, { name: 'x' })).status).toBe(403);
    expect((await member('PATCH', '/rule_missing', { name: 'x' })).status).toBe(404);

    expect((await member('POST', `/${id}/toggle`)).status).toBe(200);
    expect((await member('POST', `/${id}/toggle`)).status).toBe(200);
    expect((await as(STRANGER)('POST', `/${privateId}/toggle`)).status).toBe(403);
    expect((await member('POST', '/rule_missing/toggle')).status).toBe(404);
    const copy = await member('POST', `/${id}/duplicate`);
    expect(copy.status).toBe(201);
    expect((await as(STRANGER)('POST', `/${privateId}/duplicate`)).status).toBe(403);
    expect((await member('POST', '/rule_missing/duplicate')).status).toBe(404);

    const reorder = await member('POST', '/reorder', { rules: [{ id, priority: 5 }, { id: privateId, priority: 1 }, { id, priority: 9 }, { id: 'rule_missing', priority: 3 }] });
    expect(reorder.status).toBe(200);
    expect((await member('POST', '/reorder', { rules: [] })).status).toBe(400);

    expect((await as(STRANGER)('DELETE', `/${privateId}`)).status).toBe(403);
    expect((await member('DELETE', `/${id}`)).status).toBe(204);
    expect((await member('DELETE', `/${id}`)).status).toBe(404);
  });
});
