/**
 * The /api/lists routes the other tests leave out: PATCH, DELETE, members
 * of both kinds, removing a member, the query validation, paging and the
 * refusals. Runs against the Rust backend in conformance.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { listsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 9, minute));
  await db.insert(schema.companies).values([
    { id: 'cmp_a', name: 'A Co', displayName: 'A Co', createdAt: at(0), updatedAt: at(0) },
    { id: 'cmp_b', name: 'B Co', displayName: 'B Co', createdAt: at(0), updatedAt: at(0) },
  ]);
  await db.insert(schema.people).values([
    { id: 'per_a', firstName: 'Ann', displayName: 'Ann', createdAt: at(0), updatedAt: at(0) },
  ]);
  await db.insert(schema.lists).values([
    { id: 'list_cmp', name: 'Key accounts', kind: 'company', type: 'static', createdAt: at(1), updatedAt: at(1) },
    { id: 'list_per', name: 'Champions', kind: 'person', type: 'static', createdAt: at(2), updatedAt: at(2) },
    { id: 'list_old', name: 'Old', kind: 'company', type: 'static', deletedAt: at(3), createdAt: at(3), updatedAt: at(3) },
  ]);
  await db.insert(schema.listMembers).values([
    { id: 'lm_1', listId: 'list_cmp', entityId: 'cmp_a', addedAt: at(4) },
    { id: 'lm_2', listId: 'list_per', entityId: 'per_a', addedAt: at(5) },
  ]);
}, 60_000);

const ALL = ['companies:read', 'companies:create', 'companies:update', 'companies:delete'];

function app(...keys: string[]) {
  return createTestApp('/api/lists', listsRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ALL)), tenantDb: db },
  });
}
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('/api/lists · every route', () => {
  it('lists with paging, search and kind, and validates the query', async () => {
    const res = await app().request('/api/lists?limit=1');
    expect(res.status).toBe(200);
    const page = (await res.json()) as { data: { id: string; memberCount: number }[]; pagination: { cursor: string } };
    expect(page.data).toMatchObject([{ id: 'list_per', memberCount: 1 }]);
    expect((await app().request(`/api/lists?limit=1&cursor=${page.pagination.cursor}`)).status).toBe(200);
    expect((await app().request('/api/lists?search=Key&kind=company')).status).toBe(200);
    expect((await app().request('/api/lists?cursor=list_missing&kind=person')).status).toBe(200);
    expect((await app().request('/api/lists?limit=0')).status).toBe(400);
    expect((await app().request('/api/lists?limit=abc&kind=deal')).status).toBe(400);
  });

  it('reads members of company and person lists', async () => {
    const companies = await app().request('/api/lists/list_cmp/members');
    expect(companies.status).toBe(200);
    expect(((await companies.json()) as { data: { entityId: string }[] }).data.map((m) => m.entityId)).toEqual(['cmp_a']);
    expect((await app().request('/api/lists/list_per/members')).status).toBe(200);
    expect((await app().request('/api/lists/list_old/members')).status).toBe(404);
  });

  it('adds members of the right kind only, idempotently', async () => {
    const res = await app().request('/api/lists/list_cmp/members', json('POST', { entityIds: ['cmp_a', 'cmp_b', 'cmp_b', 'per_a', 'cmp_missing'] }));
    expect(await res.json()).toEqual({ data: { id: 'list_cmp', added: 1 } });
    const again = await app().request('/api/lists/list_cmp/members', json('POST', { entityIds: ['cmp_b'] }));
    expect(await again.json()).toEqual({ data: { id: 'list_cmp', added: 0 } });
    expect((await app().request('/api/lists/list_per/members', json('POST', { entityIds: ['per_a', 'cmp_a'] }))).status).toBe(200);
    expect((await app().request('/api/lists/list_cmp/members', json('POST', { entityIds: [] }))).status).toBe(400);
    expect((await app().request('/api/lists/list_missing/members', json('POST', { entityIds: ['x'] }))).status).toBe(404);
  });

  it('removes a member, and nothing for one that is not there', async () => {
    expect((await app().request('/api/lists/list_cmp/members/cmp_b', { method: 'DELETE' })).status).toBe(204);
    expect((await app().request('/api/lists/list_cmp/members/cmp_b', { method: 'DELETE' })).status).toBe(204);
    expect((await app().request('/api/lists/list_missing/members/cmp_b', { method: 'DELETE' })).status).toBe(404);
  });

  it('updates and deletes a list', async () => {
    const res = await app().request('/api/lists/list_cmp', json('PATCH', { name: 'Top accounts', color: 'bg-red-500', filterRules: { all: [] }, kind: 'person' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { name: string; kind: string } }).data).toMatchObject({ name: 'Top accounts', kind: 'company' });
    expect((await app().request('/api/lists/list_cmp', json('PATCH', { type: 'dynamic' }))).status).toBe(400);
    expect((await app().request('/api/lists/list_missing', json('PATCH', { name: 'x' }))).status).toBe(404);
    expect((await app().request('/api/lists', json('POST', { name: 'Smart', kind: 'person', type: 'smart', description: 'd', filterRules: 'nope' }))).status).toBe(400);
    expect((await app().request('/api/lists', json('POST', { name: 'Smart', kind: 'person', type: 'smart', filterRules: { a: 1 } }))).status).toBe(201);
    expect((await app().request('/api/lists/list_per', { method: 'DELETE' })).status).toBe(204);
    expect((await app().request('/api/lists/list_per', { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses without the permission', async () => {
    const reader = app('companies:read');
    expect((await reader.request('/api/lists', json('POST', { name: 'x', kind: 'company' }))).status).toBe(403);
    expect((await reader.request('/api/lists/list_cmp', json('PATCH', { name: 'x' }))).status).toBe(403);
    expect((await reader.request('/api/lists/list_cmp', { method: 'DELETE' })).status).toBe(403);
    expect((await reader.request('/api/lists/list_cmp/members', json('POST', { entityIds: ['cmp_a'] }))).status).toBe(403);
    expect((await reader.request('/api/lists/list_cmp/members/cmp_a', { method: 'DELETE' })).status).toBe(403);
    expect((await app('companies:update').request('/api/lists')).status).toBe(403);
  });
});
