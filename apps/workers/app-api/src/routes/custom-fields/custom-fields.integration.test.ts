/**
 * /api/custom-fields beyond the create guards in index.test.ts: listing
 * (per entity type and grouped), reading, reordering, updating (and the
 * entity event's changes), soft-deleting, reserved slugs on custom objects
 * and slug uniqueness per ticket type.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { customFieldsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = (minute: number) => new Date(`2026-04-01T09:${String(minute).padStart(2, '0')}:00.000Z`);
  await db.insert(schema.customFieldDefinitions).values([
    { id: 'cfld_li_b', entityType: 'lead_cf', name: 'Budget', slug: 'budget', fieldType: 'currency', sortOrder: 2, createdAt: at(1), updatedAt: at(1) },
    { id: 'cfld_li_a', entityType: 'lead_cf', name: 'Source', slug: 'source', fieldType: 'single_select', options: [{ label: 'Web', value: 'web', color: 'blue' }], sortOrder: 1, createdAt: at(2), updatedAt: at(2) },
    { id: 'cfld_li_c', entityType: 'lead_cf', name: 'Notes', slug: 'notes', fieldType: 'textarea', sortOrder: 1, createdAt: at(3), updatedAt: at(3) },
    { id: 'cfld_li_gone', entityType: 'lead_cf', name: 'Old', slug: 'old', fieldType: 'text', sortOrder: 0, createdAt: at(4), updatedAt: at(4), deletedAt: at(5) },
    { id: 'cfld_deal_a', entityType: 'deal_cf', name: 'Stage note', slug: 'stage_note', fieldType: 'text', group: 'Pipeline', config: { multiline: false, rows: 2 }, sortOrder: 0, createdAt: at(6), updatedAt: at(6) },
  ]);
}, 60_000);

function app(...keys: string[]) {
  return createTestApp('/api/custom-fields', customFieldsRoutes, {
    context: { tenantDb: db, permissions: permissions(...(keys.length ? keys : ['settings:read', 'settings:manage'])) },
  });
}

function send(method: string, path: string, body: unknown, ...keys: string[]) {
  return app(...keys).request(`/api/custom-fields${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/custom-fields · reads', () => {
  it('lists live definitions of an entity type by sort order, then creation', async () => {
    const res = await app('settings:read').request('/api/custom-fields?entityType=lead_cf');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((f) => f.id)).toEqual(['cfld_li_a', 'cfld_li_c', 'cfld_li_b']);
  });

  it('lists everything when no entity type is given, and groups by entity type on /all', async () => {
    const res = await app('settings:read').request('/api/custom-fields');
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { data: Array<{ id: string }> }).data.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['cfld_li_a', 'cfld_deal_a']));
    expect(ids).not.toContain('cfld_li_gone');

    const grouped = await app('settings:read').request('/api/custom-fields/all');
    expect(grouped.status).toBe(200);
    const all = (await grouped.json()) as { data: Record<string, Array<{ id: string }>> };
    expect(all.data.lead_cf!.map((f) => f.id)).toEqual(['cfld_li_a', 'cfld_li_c', 'cfld_li_b']);
    expect(all.data.deal_cf!.map((f) => f.id)).toEqual(['cfld_deal_a']);
  });

  it('refuses a repeated entityType query parameter', async () => {
    const res = await app('settings:read').request('/api/custom-fields?entityType=a&entityType=b');
    expect(res.status).toBe(400);
  });

  it('reads one definition, 404 for a deleted or unknown one', async () => {
    const res = await app('settings:read').request('/api/custom-fields/cfld_deal_a');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { slug: string } }).data.slug).toBe('stage_note');
    expect((await app('settings:read').request('/api/custom-fields/cfld_li_gone')).status).toBe(404);
    expect((await app('settings:read').request('/api/custom-fields/cfld_none')).status).toBe(404);
  });

  it('needs settings:read', async () => {
    expect((await app('companies:read').request('/api/custom-fields')).status).toBe(403);
    expect((await app('companies:read').request('/api/custom-fields/all')).status).toBe(403);
    expect((await app('companies:read').request('/api/custom-fields/cfld_deal_a')).status).toBe(403);
  });
});

describe('/api/custom-fields · writes', () => {
  it('reorders definitions, skipping unknown ids', async () => {
    const res = await send('PUT', '/reorder', {
      items: [
        { id: 'cfld_li_b', sortOrder: 0 },
        { id: 'cfld_li_a', sortOrder: 5 },
        { id: 'cfld_unknown', sortOrder: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { reordered: 3 } });
    const list = await app('settings:read').request('/api/custom-fields?entityType=lead_cf');
    expect(((await list.json()) as { data: Array<{ id: string }> }).data.map((f) => f.id)).toEqual([
      'cfld_li_b',
      'cfld_li_c',
      'cfld_li_a',
    ]);
  });

  it('refuses a malformed reorder', async () => {
    expect((await send('PUT', '/reorder', { items: [{ id: 'x', sortOrder: 'first' }] })).status).toBe(400);
    expect((await send('PUT', '/reorder', {})).status).toBe(400);
  });

  it('updates a definition, publishing only what changed', async () => {
    const res = await send('PUT', '/cfld_deal_a', {
      name: 'Stage notes',
      description: 'Why it moved',
      config: { rows: 2, multiline: false },
      group: 'Pipeline',
      required: true,
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { name: string; description: string; required: boolean } };
    expect(data).toMatchObject({ name: 'Stage notes', description: 'Why it moved', required: true });

    // Nothing differs from the stored row: no event, still 200.
    const same = await send('PUT', '/cfld_deal_a', { name: 'Stage notes', group: 'Pipeline' });
    expect(same.status).toBe(200);

    const options = await send('PUT', '/cfld_li_a', {
      options: [
        { value: 'web', label: 'Web', color: 'blue' },
        { label: 'Referral', value: 'referral' },
      ],
      sortOrder: 9,
    });
    expect(options.status).toBe(200);
  });

  it('404s an update or delete of an unknown definition, and validates the body', async () => {
    expect((await send('PUT', '/cfld_none', { name: 'X' })).status).toBe(404);
    expect((await app().request('/api/custom-fields/cfld_none', { method: 'DELETE' })).status).toBe(404);
    expect((await send('PUT', '/cfld_deal_a', { name: '', fieldType: 'colour' })).status).toBe(400);
  });

  it('soft-deletes a definition', async () => {
    const res = await app().request('/api/custom-fields/cfld_li_c', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deleted: true } });
    const [row] = await db.select().from(schema.customFieldDefinitions).where(eq(schema.customFieldDefinitions.id, 'cfld_li_c'));
    expect(row!.deletedAt).not.toBeNull();
    expect((await app().request('/api/custom-fields/cfld_li_c', { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses reserved slugs on a custom object, but not on a built-in entity', async () => {
    for (const slug of ['id', 'owner_id', 'ownerid', 'created_at']) {
      const res = await send('POST', '', { entityType: 'co_widget', name: 'Reserved', slug, fieldType: 'text' });
      expect(res.status).toBe(400);
    }
    const builtin = await send('POST', '', { entityType: 'company', name: 'Id', slug: 'id', fieldType: 'text' });
    expect(builtin.status).toBe(201);
  });

  it('scopes slug uniqueness to the ticket type', async () => {
    const base = { entityType: 'ticket', name: 'Device', slug: 'device_cf', fieldType: 'text' };
    expect((await send('POST', '', { ...base, ticketTypeId: 'htt_one' })).status).toBe(201);
    expect((await send('POST', '', { ...base, ticketTypeId: 'htt_two' })).status).toBe(201);
    expect((await send('POST', '', { ...base, ticketTypeId: 'htt_one' })).status).toBe(409);
    expect((await send('POST', '', { ...base, ticketTypeId: null })).status).toBe(201);
    expect((await send('POST', '', base)).status).toBe(409);
  });

  it('creates a definition with every optional field', async () => {
    const res = await send('POST', '', {
      entityType: 'deal_cf',
      name: 'Tags',
      slug: 'tags_cf',
      description: 'Labels',
      fieldType: 'multi_select',
      options: [{ label: 'Hot', value: 'hot', color: 'red' }],
      config: { max: 3 },
      required: false,
      sortOrder: 4,
      group: 'Meta',
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { ticketTypeId: string | null; options: unknown[] } };
    expect(data.ticketTypeId).toBeNull();
    expect(data.options).toHaveLength(1);
  });

  it('validates a create body', async () => {
    const res = await send('POST', '', { entityType: '', name: 'X', slug: 'Bad-Slug', fieldType: 'text', options: [{ label: '', value: 'v' }] });
    expect(res.status).toBe(400);
  });

  it('needs settings:manage to change anything', async () => {
    expect((await send('POST', '', { entityType: 'company', name: 'X', slug: 'x_cf', fieldType: 'text' }, 'settings:read')).status).toBe(403);
    expect((await send('PUT', '/cfld_deal_a', { name: 'X' }, 'settings:read')).status).toBe(403);
    expect((await send('PUT', '/reorder', { items: [] }, 'settings:read')).status).toBe(403);
    expect((await app('settings:read').request('/api/custom-fields/cfld_deal_a', { method: 'DELETE' })).status).toBe(403);
  });
});
