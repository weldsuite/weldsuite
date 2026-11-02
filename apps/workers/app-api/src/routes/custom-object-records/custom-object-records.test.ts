/**
 * /api/objects/:slug/records: the generic record surface of every custom
 * object. Slug resolution and the per-object permission, owner scoping,
 * listing (sort, search, custom-field filters, offset cursor), per-type
 * value validation, title maintenance, record events and the link-aware
 * delete.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { customObjectRecordsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { OTHER, seedCustomObjects } from '../../test/custom-object-fixtures';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedCustomObjects(db);
}, 60_000);

const ALL = ['weldobjects:asset:read', 'weldobjects:asset:scope:all'];

function app(...keys: string[]) {
  return createTestApp('/api/objects', customObjectRecordsRoutes, {
    context: { tenantDb: db, permissions: permissions(...keys) },
  });
}

async function ids(path: string, ...keys: string[]) {
  const res = await app(...(keys.length ? keys : ALL)).request(`/api/objects/asset/records${path}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: Array<{ id: string }>;
    pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
  };
  return { ids: body.data.map((r) => r.id), pagination: body.pagination };
}

function send(method: string, path: string, body: unknown, ...keys: string[]) {
  return app(...keys).request(`/api/objects${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/objects/:slug/records · resolution and permission', () => {
  it('404s an unknown or disabled object, before checking the permission', async () => {
    const unknown = await app('*').request('/api/objects/nope/records');
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { message: string } }).error.message).toBe("Custom object with ID 'nope' not found");
    expect((await app('*').request('/api/objects/gadget/records')).status).toBe(404);
    expect((await app().request('/api/objects/nope/records/cor_x')).status).toBe(404);
  });

  it('refuses a caller without the per-object permission', async () => {
    const res = await app('weldobjects:site:read').request('/api/objects/asset/records');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'You do not have permission to read assets' } });
    expect((await app('weldobjects:asset:read').request('/api/objects/asset/records/cor_as_1', { method: 'DELETE' })).status).toBe(403);
  });

  it('accepts wildcard grants', async () => {
    expect((await app('weldobjects:*').request('/api/objects/asset/records')).status).toBe(200);
    expect((await app('weldobjects:*:read').request('/api/objects/asset/records')).status).toBe(200);
  });
});

describe('/api/objects/:slug/records · list', () => {
  it('lists newest first with hydrated fields', async () => {
    const res = await app(...ALL).request('/api/objects/asset/records');
    const body = (await res.json()) as { data: Array<{ id: string; fields: Record<string, unknown> }> };
    expect(body.data.map((r) => r.id)).toEqual(['cor_as_4', 'cor_as_3', 'cor_as_2', 'cor_as_1']);
    expect(body.data[3]!.fields).toEqual({
      name: 'Alpha press',
      serial: 'AB-100',
      power: 5,
      installed: '2026-01-02T10:00:00.000Z',
      active: true,
      tier: 'gold',
      tags: ['red', 'blue'],
      tech: 'user_x',
    });
  });

  it('scopes to the caller’s own records without scope:all, which beats ownerId', async () => {
    expect((await ids('', 'weldobjects:asset:read')).ids).toEqual(['cor_as_4', 'cor_as_3', 'cor_as_1']);
    expect((await ids(`?ownerId=${OTHER}`)).ids).toEqual(['cor_as_2']);
    expect((await ids(`?ownerId=${OTHER}`, 'weldobjects:asset:read')).ids).toEqual(['cor_as_4', 'cor_as_3', 'cor_as_1']);
  });

  it('sorts by title, updatedAt, a custom field or creation', async () => {
    expect((await ids('?sort=title&direction=asc')).ids).toEqual(['cor_as_1', 'cor_as_2', 'cor_as_4', 'cor_as_3']);
    expect((await ids('?sort=title')).ids).toEqual(['cor_as_3', 'cor_as_4', 'cor_as_2', 'cor_as_1']);
    expect((await ids('?sort=updatedAt')).ids).toEqual(['cor_as_1', 'cor_as_3', 'cor_as_2', 'cor_as_4']);
    expect((await ids('?sort=updatedAt&direction=asc')).ids).toEqual(['cor_as_4', 'cor_as_2', 'cor_as_3', 'cor_as_1']);
    expect((await ids('?sort=custom:power&direction=asc')).ids).toEqual(['cor_as_4', 'cor_as_1', 'cor_as_2', 'cor_as_3']);
    expect((await ids('?sort=custom:power')).ids).toEqual(['cor_as_2', 'cor_as_4', 'cor_as_1', 'cor_as_3']);
    expect((await ids('?sort=custom:serial&direction=asc')).ids).toEqual(['cor_as_1', 'cor_as_2', 'cor_as_3', 'cor_as_4']);
    expect((await ids('?sort=custom:installed')).ids).toEqual(['cor_as_2', 'cor_as_1', 'cor_as_4', 'cor_as_3']);
    expect((await ids('?sort=custom:active&direction=asc')).ids).toEqual(['cor_as_2', 'cor_as_1', 'cor_as_4', 'cor_as_3']);
    expect((await ids('?sort=custom:nope&direction=asc')).ids).toEqual(['cor_as_1', 'cor_as_2', 'cor_as_3', 'cor_as_4']);
    expect((await ids('?sort=custom:&direction=sideways')).ids).toEqual(['cor_as_4', 'cor_as_3', 'cor_as_2', 'cor_as_1']);
  });

  it('searches titles, with LIKE wildcards taken literally', async () => {
    expect((await ids('?search=alp')).ids).toEqual(['cor_as_1']);
    expect((await ids('?search=50%25')).ids).toEqual(['cor_as_2']);
    expect((await ids('?search=%25')).ids).toEqual(['cor_as_2']);
    expect((await ids('?search=_')).ids).toEqual([]);
  });

  it('filters by custom fields, per type', async () => {
    expect((await ids('?filter[custom:serial]=ab')).ids).toEqual(['cor_as_3', 'cor_as_1']);
    expect((await ids('?filter[custom:power]=5')).ids).toEqual(['cor_as_4', 'cor_as_1']);
    expect((await ids('?filter[custom:power]=12.5')).ids).toEqual(['cor_as_2']);
    expect((await ids('?filter[custom:installed]=2026-01-02')).ids).toEqual(['cor_as_1']);
    expect((await ids('?filter[custom:active]=false')).ids).toEqual(['cor_as_2']);
    expect((await ids('?filter[custom:tags]=red')).ids).toEqual(['cor_as_1']);
    expect((await ids('?filter[custom:tier]=GOLD')).ids).toEqual(['cor_as_1']);
    expect((await ids('?filter[custom:tech]=user_x')).ids).toEqual(['cor_as_1']);
    expect((await ids('?filter[custom:serial]=ab&filter[custom:power]=5')).ids).toEqual(['cor_as_1']);
    // Not a custom field key: ignored.
    expect((await ids('?filter[title]=nothing')).ids).toHaveLength(4);
  });

  it('answers an empty page for a filter that cannot match', async () => {
    for (const query of ['?filter[custom:power]=abc', '?filter[custom:active]=maybe', '?filter[custom:installed]=someday', '?filter[custom:missing]=x']) {
      const page = await ids(query);
      expect(page.ids).toEqual([]);
      expect(page.pagination).toEqual({ totalCount: 0, hasMore: false, cursor: null });
    }
  });

  it('pages with an offset cursor and a clamped limit', async () => {
    const first = await ids('?limit=3');
    expect(first.ids).toEqual(['cor_as_4', 'cor_as_3', 'cor_as_2']);
    expect(first.pagination).toEqual({ totalCount: 4, hasMore: true, cursor: 'o3' });
    const second = await ids('?limit=3&cursor=o3');
    expect(second.ids).toEqual(['cor_as_1']);
    expect(second.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });
    expect((await ids('?limit=0')).ids).toHaveLength(1);
    expect((await ids('?limit=abc')).ids).toHaveLength(4);
    expect((await ids('?limit=500&cursor=x9')).ids).toHaveLength(4);
    expect((await ids('?cursor=o-2')).ids).toHaveLength(4);
  });
});

describe('/api/objects/:slug/records · read one', () => {
  it('reads a record with its fields; another owner’s is a 404 without scope:all', async () => {
    const res = await app(...ALL).request('/api/objects/asset/records/cor_as_4');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { fields: unknown } }).data.fields).toEqual({
      name: 'Gamma',
      power: 5,
      manual: { url: 'https://files.example/manual.pdf', size: 1200 },
    });
    expect((await app(...ALL).request('/api/objects/asset/records/cor_as_2')).status).toBe(200);
    const hidden = await app('weldobjects:asset:read').request('/api/objects/asset/records/cor_as_2');
    expect(hidden.status).toBe(404);
    expect(((await hidden.json()) as { error: { message: string } }).error.message).toBe("Asset with ID 'cor_as_2' not found");
    expect((await app(...ALL).request('/api/objects/asset/records/cor_as_dead')).status).toBe(404);
    expect((await app('weldobjects:site:read').request('/api/objects/site/records/cor_as_1')).status).toBe(404);
  });
});

describe('/api/objects/:slug/records · create', () => {
  const CREATE = ['weldobjects:asset:create'];

  it('creates a record, validating and coercing each field, and derives its title', async () => {
    const res = await send(
      'POST',
      '/asset/records',
      {
        fields: {
          name: 'Delta drill',
          serial: 'D-1',
          power: '7.5',
          installed: '2026-03-04',
          active: 1,
          tier: 'silver',
          tags: ['red', 'green'],
          tech: 'user_y',
          manual: { url: 'https://files.example/d.pdf' },
          rating: 4,
          unknown_field: 'ignored',
        },
      },
      ...CREATE,
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; title: string; ownerId: string; fields: Record<string, unknown> } };
    expect(data.title).toBe('Delta drill');
    expect(data.ownerId).toBe('user_test_default');
    expect(data.fields.power).toBe('7.5');

    const stored = await app(...ALL).request(`/api/objects/asset/records/${data.id}`);
    expect(((await stored.json()) as { data: { fields: Record<string, unknown> } }).data.fields).toEqual({
      name: 'Delta drill',
      serial: 'D-1',
      power: 7.5,
      installed: '2026-03-04T00:00:00.000Z',
      active: true,
      tier: 'silver',
      tags: ['red', 'green'],
      tech: 'user_y',
      manual: { url: 'https://files.example/d.pdf' },
      rating: 4,
    });
  });

  it('takes an explicit owner, and a single value for a multi-select', async () => {
    const res = await send('POST', '/asset/records', { fields: { name: 'Owned', tags: 'blue', active: false }, ownerId: OTHER }, ...CREATE);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { ownerId: string } }).data.ownerId).toBe(OTHER);
  });

  it('refuses an invalid value with the field’s message', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ serial: 'no name' }, "'name' is required"],
      [{ name: '' }, "'name' is required"],
      [{ name: 'X', power: 'lots' }, "'power' must be a number"],
      [{ name: 'X', installed: 'not a date' }, "'installed' must be a valid date"],
      [{ name: 'X', tier: 'bronze' }, "'bronze' is not a valid option for 'tier'"],
      [{ name: 'X', tags: ['red', 'pink'] }, "'pink' is not a valid option for 'tags'"],
    ];
    for (const [fields, message] of cases) {
      const res = await send('POST', '/asset/records', { fields }, ...CREATE);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe(message);
    }
  });

  it('validates the body shape', async () => {
    expect((await send('POST', '/asset/records', { fields: 'name=x' }, ...CREATE)).status).toBe(400);
    expect((await send('POST', '/asset/records', { fields: {}, ownerId: 'u'.repeat(256) }, ...CREATE)).status).toBe(400);
  });

  it('creates on an object without events, titling from the first text field', async () => {
    const res = await send('POST', '/site/records', { fields: { label: 'West' } }, 'weldobjects:site:create');
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { title: string } }).data.title).toBe('West');
    const untitled = await send('POST', '/site/records', {}, 'weldobjects:site:create');
    expect(untitled.status).toBe(201);
    expect(((await untitled.json()) as { data: { title: null; fields: unknown } }).data).toMatchObject({ title: null, fields: {} });
  });

  it('needs the create permission', async () => {
    expect((await send('POST', '/asset/records', { fields: { name: 'X' } }, 'weldobjects:asset:read')).status).toBe(403);
    expect((await send('POST', '/gadget/records', { fields: {} }, '*')).status).toBe(404);
  });
});

describe('/api/objects/:slug/records · update', () => {
  const UPDATE = ['weldobjects:asset:update', 'weldobjects:asset:scope:all'];

  it('patches fields, keeps the title from the title field, and clears values', async () => {
    const res = await send('PATCH', '/asset/records/cor_as_1', { fields: { serial: 'AB-101', power: null, tags: ['green'] }, ownerId: null }, ...UPDATE);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { title: string; ownerId: null; fields: Record<string, unknown>; updatedBy: string } };
    expect(data.title).toBe('Alpha press');
    expect(data.ownerId).toBeNull();
    expect(data.fields.serial).toBe('AB-101');
    expect(data.fields).not.toHaveProperty('power');
  });

  it('retitles when the title field changes, and allows clearing a required field', async () => {
    const res = await send('PATCH', '/asset/records/cor_as_4', { fields: { name: 'Gamma prime' } }, ...UPDATE);
    expect(((await res.json()) as { data: { title: string } }).data.title).toBe('Gamma prime');
    const cleared = await send('PATCH', '/asset/records/cor_as_4', { fields: { name: null } }, ...UPDATE);
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { data: { title: string | null } }).data.title).toBeNull();
    const owner = await send('PATCH', '/asset/records/cor_as_4', { ownerId: 'user_new' }, ...UPDATE);
    expect(((await owner.json()) as { data: { ownerId: string } }).data.ownerId).toBe('user_new');
    const nothing = await send('PATCH', '/asset/records/cor_as_4', {}, ...UPDATE);
    expect(nothing.status).toBe(200);
  });

  it('refuses invalid values, hidden records and missing permission', async () => {
    const bad = await send('PATCH', '/asset/records/cor_as_2', { fields: { tier: 'bronze' } }, ...UPDATE);
    expect(bad.status).toBe(400);
    expect((await send('PATCH', '/asset/records/cor_as_2', { fields: { serial: 'x' } }, 'weldobjects:asset:update')).status).toBe(404);
    expect((await send('PATCH', '/asset/records/cor_none', { fields: {} }, ...UPDATE)).status).toBe(404);
    expect((await send('PATCH', '/asset/records/cor_as_2', { fields: [] }, ...UPDATE)).status).toBe(400);
    expect((await send('PATCH', '/asset/records/cor_as_2', { fields: {} }, 'weldobjects:asset:read')).status).toBe(403);
  });
});

describe('/api/objects/:slug/records · delete', () => {
  const DELETE = ['weldobjects:asset:delete', 'weldobjects:asset:scope:all'];
  const remove = (id: string, ...keys: string[]) => app(...(keys.length ? keys : DELETE)).request(`/api/objects/asset/records/${id}`, { method: 'DELETE' });

  it('refuses while a restricting relationship points at the record', async () => {
    const res = await remove('cor_as_4');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: 'CONFLICT',
        message: "This asset still has Anchored sites linked to it. Unlink them first, or change the relationship's delete rule.",
        details: { blockedBy: ['Anchored sites'] },
      },
    });
  });

  it('deletes a record and cascades to the records that depend on it', async () => {
    const res = await remove('cor_as_3');
    expect(res.status).toBe(204);
    const [site] = await db.select().from(schema.customObjectRecords).where(eq(schema.customObjectRecords.id, 'cor_site_2'));
    expect(site!.deletedAt).not.toBeNull();
    const values = await db.select().from(schema.customFieldValues).where(eq(schema.customFieldValues.entityId, 'cor_as_3'));
    expect(values).toHaveLength(0);
    expect((await remove('cor_as_3')).status).toBe(404);
  });

  it('deletes a plain record; another owner’s is hidden without scope:all', async () => {
    expect((await remove('cor_as_2', 'weldobjects:asset:delete')).status).toBe(404);
    expect((await remove('cor_as_2')).status).toBe(204);
  });
});
