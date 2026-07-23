/**
 * DB-backed integration tests for the Phase-2 conversation-list filters
 * (`createdById`, `mentionedUserId`) and the reply route's `mentionUserIds`
 * input, proving they're wired end to end through the HTTP layer. Filter
 * semantics themselves are covered in
 * services/desk/conversations-filters-pglite.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { deskConversationsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import type { Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

function app(perm: string, userId = 'user_test_default') {
  return createTestApp('/api/desk/conversations', deskConversationsRoutes, {
    context: { permissions: permissions(perm), tenantDb: db, userId },
  }).request;
}

describe('/api/desk/conversations · createdById / mentionedUserId · pglite integration', () => {
  it('GET /?createdById=<me> returns only conversations I created', async () => {
    const creator = 'user_created_by_route_1';
    const createRes = await app('conversations:create', creator)('/api/desk/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'messenger', body: 'Mine', deliveredAs: 'admin_initiated' }),
    });
    const { data: mine } = (await createRes.json()) as { data: { id: string } };

    await app('conversations:create', 'user_other_creator')('/api/desk/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'messenger', body: 'Not mine', deliveredAs: 'admin_initiated' }),
    });

    const res = await app('conversations:read')(`/api/desk/conversations?createdById=${creator}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((c) => c.id === mine.id)).toBe(true);
  });

  it('POST /:id/reply with mentionUserIds on a note makes it show up under mentionedUserId', async () => {
    const createRes = await app('conversations:create')('/api/desk/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'messenger', body: 'Need review' }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const replyRes = await app('conversations:update')(`/api/desk/conversations/${created.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageType: 'note',
        body: '@carol can you take a look?',
        mentionUserIds: ['user_carol'],
      }),
    });
    expect(replyRes.status).toBe(201);

    const listRes = await app('conversations:read')('/api/desk/conversations?mentionedUserId=user_carol');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.some((c) => c.id === created.id)).toBe(true);
  });

  it('mentionUserIds on a comment (not a note) is ignored — comments go to the customer', async () => {
    const createRes = await app('conversations:create')('/api/desk/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'messenger', body: 'Hello' }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    await app('conversations:update')(`/api/desk/conversations/${created.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageType: 'comment',
        body: 'Thanks for reaching out',
        mentionUserIds: ['user_dave'],
      }),
    });

    const listRes = await app('conversations:read')('/api/desk/conversations?mentionedUserId=user_dave');
    const listBody = (await listRes.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.some((c) => c.id === created.id)).toBe(false);
  });
});
