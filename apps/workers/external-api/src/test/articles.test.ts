/**
 * `/v1/articles` (WeldDesk's knowledge base) beyond the CRUD round-trip — the
 * derived slug, content and author, the filters, the refusals.
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

