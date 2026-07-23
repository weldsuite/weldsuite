/**
 * DB-backed integration tests for /api/desk/views — proving validation →
 * service → response envelope, plus the owner-only mutation gate at the HTTP
 * layer (403 FORBIDDEN). Owner-vs-shared visibility itself is covered in
 * services/desk/views-pglite.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { deskViewsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import type { Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

function app(perm: string, userId = 'user_test_default') {
  return createTestApp('/api/desk/views', deskViewsRoutes, {
    context: { permissions: permissions(perm), tenantDb: db, userId },
  }).request;
}

const emptyFilters = { groups: [] };

describe('/api/desk/views · pglite integration', () => {
  it('POST / creates a view owned by the caller', async () => {
    const request = app('conversations:create', 'user_view_owner_1');
    const res = await request('/api/desk/views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My Inbox', filters: emptyFilters, sort: 'newest', shared: false }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; ownerId: string } };
    expect(body.data.id).toMatch(/^dview_/);
    expect(body.data.ownerId).toBe('user_view_owner_1');
  });

  it('PATCH /:id by a non-owner returns 403', async () => {
    const createRes = await app('conversations:create', 'user_view_owner_2')('/api/desk/views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Shared view', filters: emptyFilters, sort: 'newest', shared: true }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const res = await app('conversations:update', 'user_intruder')(`/api/desk/views/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    expect(res.status).toBe(403);
  });

  it('PATCH /:id by the owner succeeds', async () => {
    const createRes = await app('conversations:create', 'user_view_owner_3')('/api/desk/views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Owned view', filters: emptyFilters, sort: 'newest' }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const res = await app('conversations:update', 'user_view_owner_3')(`/api/desk/views/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed view' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { name: string } }).data.name).toBe('Renamed view');
  });

  it('DELETE /:id by a non-owner returns 403; owner gets 204', async () => {
    const createRes = await app('conversations:create', 'user_view_owner_4')('/api/desk/views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'To delete', filters: emptyFilters, sort: 'newest' }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const forbidden = await app('conversations:delete', 'user_intruder')(`/api/desk/views/${created.id}`, {
      method: 'DELETE',
    });
    expect(forbidden.status).toBe(403);

    const ok = await app('conversations:delete', 'user_view_owner_4')(`/api/desk/views/${created.id}`, {
      method: 'DELETE',
    });
    expect(ok.status).toBe(204);
  });

  it('GET / returns own + shared views', async () => {
    await app('conversations:create', 'user_view_owner_5')('/api/desk/views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Owner5 private', filters: emptyFilters, sort: 'newest', shared: false }),
    });
    const sharedCreate = await app('conversations:create', 'user_view_owner_6')('/api/desk/views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Owner6 shared', filters: emptyFilters, sort: 'newest', shared: true }),
    });
    const { data: shared } = (await sharedCreate.json()) as { data: { id: string } };

    const res = await app('conversations:read', 'user_view_owner_5')('/api/desk/views');
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((v) => v.id === shared.id)).toBe(true);
  });
});
