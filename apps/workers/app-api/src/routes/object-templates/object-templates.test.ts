/**
 * /api/object-templates: named field sets for create forms, readable with
 * companies:read and managed with companies:update.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { objectTemplatesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = new Date('2026-03-01T10:00:00.000Z');
  await db.insert(schema.objectTemplates).values([
    { id: 'crmtpl_seed_b', entityType: 'company', name: 'Wholesale', slug: 'wholesale', fields: ['name', 'vat'], sortOrder: 1, createdAt: at, updatedAt: at },
    { id: 'crmtpl_seed_a', entityType: 'company', name: 'Agency', slug: 'agency', fields: ['name'], sortOrder: 1, createdAt: at, updatedAt: at },
    { id: 'crmtpl_seed_p', entityType: 'person', name: 'Speaker', slug: 'speaker', fields: ['fullName'], isDefault: true, createdAt: at, updatedAt: at },
    { id: 'crmtpl_seed_gone', entityType: 'company', name: 'Gone', slug: 'gone', fields: ['name'], createdAt: at, updatedAt: at, deletedAt: at },
  ]);
}, 60_000);

function app(...keys: string[]) {
  return createTestApp('/api/object-templates', objectTemplatesRoutes, {
    context: { tenantDb: db, permissions: permissions(...(keys.length ? keys : ['companies:read', 'companies:update'])) },
  });
}

function send(method: string, path: string, body: unknown, ...keys: string[]) {
  return app(...keys).request(`/api/object-templates${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/object-templates · reads', () => {
  it('lists live templates by sort order then name, optionally per entity type', async () => {
    const all = await app('companies:read').request('/api/object-templates');
    expect(all.status).toBe(200);
    const body = (await all.json()) as { data: Array<{ id: string }>; pagination: { totalCount: number } };
    expect(body.data.map((t) => t.id)).toEqual(['crmtpl_seed_p', 'crmtpl_seed_a', 'crmtpl_seed_b']);
    expect(body.pagination.totalCount).toBe(3);

    const companies = await app('companies:read').request('/api/object-templates?entityType=company');
    const list = (await companies.json()) as { data: Array<{ id: string }> };
    expect(list.data.map((t) => t.id)).toEqual(['crmtpl_seed_a', 'crmtpl_seed_b']);

    // A malformed entity type is ignored rather than refused.
    const ignored = await app('companies:read').request('/api/object-templates?entityType=Not%20A%20Slug');
    expect(((await ignored.json()) as { data: unknown[] }).data).toHaveLength(3);
  });

  it('reads one template, 404 for a deleted or unknown one', async () => {
    const one = await app('companies:read').request('/api/object-templates/crmtpl_seed_a');
    expect(one.status).toBe(200);
    expect(((await one.json()) as { data: { slug: string } }).data.slug).toBe('agency');
    expect((await app('companies:read').request('/api/object-templates/crmtpl_seed_gone')).status).toBe(404);
    expect((await app('companies:read').request('/api/object-templates/crmtpl_nope')).status).toBe(404);
  });

  it('needs companies:read', async () => {
    expect((await app('people:read').request('/api/object-templates')).status).toBe(403);
    expect((await app('people:read').request('/api/object-templates/crmtpl_seed_a')).status).toBe(403);
  });
});

describe('/api/object-templates · writes', () => {
  it('creates, updates and deletes a template', async () => {
    const created = await send('POST', '', {
      entityType: 'company',
      name: 'Reseller',
      slug: 'reseller',
      description: 'Partners who resell',
      fields: ['name', 'website'],
    });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string; isDefault: boolean; sortOrder: number } };
    expect(data.isDefault).toBe(false);
    expect(data.sortOrder).toBe(0);

    const updated = await send('PATCH', `/${data.id}`, { name: 'Reseller partner', isDefault: true, sortOrder: 4 });
    expect(updated.status).toBe(200);
    const after = (await updated.json()) as { data: { name: string; isDefault: boolean; slug: string } };
    expect(after.data).toMatchObject({ name: 'Reseller partner', isDefault: true, slug: 'reseller' });

    const removed = await app().request(`/api/object-templates/${data.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect((await app().request(`/api/object-templates/${data.id}`)).status).toBe(404);
    expect((await app().request(`/api/object-templates/${data.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('answers 500 for a slug already used on the entity type', async () => {
    const res = await send('POST', '', { entityType: 'company', name: 'Agency 2', slug: 'agency', fields: ['name'] });
    expect(res.status).toBe(500);
  });

  it('validates the body', async () => {
    const bad = await send('POST', '', { entityType: 'Company', name: '', slug: 'Bad Slug', fields: [] });
    expect(bad.status).toBe(400);
    const missing = await send('POST', '', { name: 'X' });
    expect(missing.status).toBe(400);
    const badPatch = await send('PATCH', '/crmtpl_seed_a', { fields: [''], sortOrder: 1.5 });
    expect(badPatch.status).toBe(400);
  });

  it('404s an update of an unknown template', async () => {
    const res = await send('PATCH', '/crmtpl_nope', { name: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('needs companies:update', async () => {
    const res = await send('POST', '', { entityType: 'company', name: 'X', slug: 'x', fields: ['name'] }, 'companies:read');
    expect(res.status).toBe(403);
    expect((await send('PATCH', '/crmtpl_seed_a', { name: 'X' }, 'companies:read')).status).toBe(403);
    expect((await app('companies:read').request('/api/object-templates/crmtpl_seed_a', { method: 'DELETE' })).status).toBe(403);
  });
});
