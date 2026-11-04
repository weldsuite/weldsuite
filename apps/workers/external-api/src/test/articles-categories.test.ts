/**
 * `/v1/articles` (WeldDesk's knowledge base) beyond the CRUD round-trip — the
 * derived slug, content and author, the filters, the refusals — and
 * `/v1/categories` (WeldCommerce's product categories, the generic CRUD
 * route), which the contract matrix does not list.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';
import type { ApiKeySession } from '../types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function api(scopes: string[] = ['*']) {
  return createExternalTestApp({ scopes, tenantDb: db });
}

function workspaceKey() {
  const session: ApiKeySession = {
    keyId: 'key_ws',
    keyType: 'workspace',
    workspaceId: 'ws_test',
    userId: null,
    scopes: ['*'],
    tier: 'enterprise',
    databaseUrl: null,
    licensedApps: null,
  };
  return createExternalTestApp({ session, tenantDb: db });
}

const post = (path: string, body: unknown, app = api()) =>
  app.request(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
const patch = (path: string, body: unknown, app = api()) =>
  app.request(path, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function ids(path: string): Promise<string[]> {
  const res = await api().request(path);
  expect(res.status, path).toBe(200);
  return ((await res.json()) as { data: { id: string }[] }).data.map((r) => r.id);
}

describe('external-api · articles', () => {
  it('derives the slug, content and author, filters, and updates', async () => {
    const created = await post('/v1/articles', { title: '  Reset your Password! ', body: 'Click reset.', status: 'published' });
    expect(created.status, await created.clone().text()).toBe(201);
    const article = await data<{ id: string; slug: string; content: string; authorId: string }>(created);
    expect(article).toMatchObject({ slug: 'reset-your-password', content: 'Click reset.', authorId: 'user_test' });

    const symbols = await data<{ id: string; slug: string }>(await post('/v1/articles', { title: '???', slug: '' }));
    expect(symbols.slug).toBe(symbols.id);

    expect(await ids('/v1/articles?search=Password&status=published&authorId=user_test')).toContain(article.id);

    const updated = await patch(`/v1/articles/${article.id}`, { bodyHtml: '<p>Click reset.</p>', title: 'Reset' });
    expect(updated.status).toBe(200);
    expect((await data<{ content: string }>(updated)).content).toBe('<p>Click reset.</p>');
    expect((await patch(`/v1/articles/${article.id}`, { status: 'nope' })).status).toBe(400);

    expect((await post('/v1/articles', { title: 'Team' }, workspaceKey())).status).toBe(400);
    const authored = await post('/v1/articles', { title: 'Team', authorId: 'user_test' }, workspaceKey());
    expect(authored.status).toBe(201);

    expect((await api().request(`/v1/articles/${article.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await patch(`/v1/articles/${article.id}`, { title: 'x' })).status).toBe(404);
    expect((await api().request(`/v1/articles/${article.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('external-api · categories', () => {
  it('lists, creates with the defaults, updates and deletes', async () => {
    const empty = await api(['categories:read']).request('/v1/categories');
    expect(empty.status).toBe(200);
    expect((await api(['unrelated:read']).request('/v1/categories')).status).toBe(403);
    expect((await createExternalTestApp({ session: null, tenantDb: db }).request('/v1/categories')).status).toBe(401);

    const created = await post('/v1/categories', { name: 'Summer Sale!', isActive: true, description: null });
    expect(created.status, await created.clone().text()).toBe(201);
    const category = await data<{ id: string; slug: string; type: string; isActive: number; depth: number }>(created);
    expect(category).toMatchObject({ slug: 'summer-sale', type: 'manual', isActive: 1, depth: 0 });

    const child = await post('/v1/categories', { name: 'Shorts', parentId: category.id, type: 'automated', isActive: 0 });
    expect(child.status).toBe(201);
    const childRow = await data<{ id: string }>(child);
    expect(await ids(`/v1/categories?parentId=${category.id}&type=automated`)).toEqual([childRow.id]);
    expect(await ids('/v1/categories?search=summer')).toContain(category.id);

    expect((await api().request(`/v1/categories/${category.id}`)).status).toBe(200);
    expect((await api().request('/v1/categories/cat_missing')).status).toBe(404);

    const updated = await patch(`/v1/categories/${category.id}`, { isActive: false, position: 2 });
    expect(updated.status).toBe(200);
    expect((await data<{ isActive: number }>(updated)).isActive).toBe(0);
    expect((await patch(`/v1/categories/${category.id}`, { isActive: 'yes' })).status).toBe(400);
    expect((await patch('/v1/categories/cat_missing', { name: 'x' })).status).toBe(404);
    expect((await post('/v1/categories', { name: '' })).status).toBe(400);
    expect((await post('/v1/categories', { name: 'x' }, api(['categories:read']))).status).toBe(403);

    expect((await api().request(`/v1/categories/${category.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api().request(`/v1/categories/${category.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});
