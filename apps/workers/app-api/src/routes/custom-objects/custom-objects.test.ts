/**
 * /api/custom-objects: object type definitions (list, read, delete impact,
 * reorder, create, update, cascade delete) and their relationship
 * definitions (link targets, list, create, update, delete), mounted as
 * app-api mounts them.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { customObjectsRoutes } from './index';
import { customObjectLinkDefinitionRoutes } from '../custom-object-links';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

let db: Database;

const at = (day: number) => new Date(`2026-05-${String(day).padStart(2, '0')}T08:00:00.000Z`);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.customObjects).values([
    {
      id: 'cobj_machine',
      slug: 'machine',
      entityKey: 'co_machine',
      labelSingular: 'Machine',
      labelPlural: 'Machines',
      description: 'Installed equipment',
      status: 'active',
      enableSearch: true,
      sortOrder: 1,
      createdAt: at(1),
      updatedAt: at(1),
    },
    {
      id: 'cobj_cert',
      slug: 'certification',
      entityKey: 'co_certification',
      labelSingular: 'Certification',
      labelPlural: 'Certifications',
      sortOrder: 0,
      createdAt: at(2),
      updatedAt: at(2),
    },
    {
      id: 'cobj_visit',
      slug: 'visit',
      entityKey: 'co_visit',
      labelSingular: 'Visit',
      labelPlural: 'Visits',
      status: 'active',
      sortOrder: 1,
      createdAt: at(3),
      updatedAt: at(3),
    },
    {
      id: 'cobj_retired',
      slug: 'retired',
      entityKey: 'co_retired',
      labelSingular: 'Retired',
      labelPlural: 'Retireds',
      createdAt: at(4),
      updatedAt: at(4),
      deletedAt: at(5),
    },
  ]);
  await db.insert(schema.customFieldDefinitions).values([
    { id: 'cfld_mach_serial', entityType: 'co_machine', name: 'Serial', slug: 'serial', fieldType: 'text', createdAt: at(1), updatedAt: at(1) },
    { id: 'cfld_mach_power', entityType: 'co_machine', name: 'Power', slug: 'power', fieldType: 'number', createdAt: at(1), updatedAt: at(1) },
    { id: 'cfld_cert_name', entityType: 'co_certification', name: 'Name', slug: 'name', fieldType: 'text', createdAt: at(2), updatedAt: at(2) },
  ]);
  await db.insert(schema.customObjectRecords).values([
    { id: 'cor_mach_1', objectId: 'cobj_machine', entityKey: 'co_machine', title: 'CNC 1', createdAt: at(6), updatedAt: at(6) },
    { id: 'cor_mach_2', objectId: 'cobj_machine', entityKey: 'co_machine', title: 'CNC 2', createdAt: at(6), updatedAt: at(6) },
    { id: 'cor_mach_3', objectId: 'cobj_machine', entityKey: 'co_machine', title: 'Old', createdAt: at(6), updatedAt: at(6), deletedAt: at(7) },
    { id: 'cor_cert_1', objectId: 'cobj_cert', entityKey: 'co_certification', title: 'ISO', createdAt: at(6), updatedAt: at(6) },
  ]);
  await db.insert(schema.customFieldValues).values([
    { id: 'cfv_cert_1', fieldId: 'cfld_cert_name', entityType: 'co_certification', entityId: 'cor_cert_1', valueText: 'ISO', createdAt: at(6), updatedAt: at(6) },
  ]);
  await db.insert(schema.customObjectLinks).values([
    // Certifications point at machines and block deleting one that is linked.
    {
      id: 'colk_cert_machine',
      slug: 'machine',
      sourceEntityKey: 'co_certification',
      targetEntityKey: 'co_machine',
      cardinality: 'many_to_one',
      sourceLabel: 'Certifications',
      targetLabel: 'Machine',
      onDelete: 'restrict',
      createdAt: at(6),
      updatedAt: at(6),
    },
    {
      id: 'colk_machine_company',
      slug: 'customer',
      sourceEntityKey: 'co_machine',
      targetEntityKey: 'company',
      cardinality: 'many_to_one',
      sourceLabel: 'Machines',
      targetLabel: 'Customer',
      sortOrder: 2,
      createdAt: at(6),
      updatedAt: at(6),
    },
    {
      id: 'colk_machine_visits',
      slug: 'visits',
      sourceEntityKey: 'co_machine',
      targetEntityKey: 'co_visit',
      cardinality: 'one_to_many',
      sourceLabel: 'Machine',
      targetLabel: 'Visits',
      sortOrder: 2,
      createdAt: at(6),
      updatedAt: at(6),
    },
    {
      id: 'colk_visit_cert',
      slug: 'certification',
      sourceEntityKey: 'co_visit',
      targetEntityKey: 'co_certification',
      cardinality: 'many_to_one',
      sourceLabel: 'Visits',
      targetLabel: 'Certification',
      onDelete: 'restrict',
      createdAt: at(6),
      updatedAt: at(6),
    },
  ]);
  await db.insert(schema.customObjectRelations).values([
    {
      id: 'corl_cert_mach',
      linkId: 'colk_cert_machine',
      sourceEntityKey: 'co_certification',
      sourceId: 'cor_cert_1',
      targetEntityKey: 'co_machine',
      targetId: 'cor_mach_1',
      createdAt: at(6),
    },
  ]);
}, 60_000);

/** Mounted in app-api's order (src/index.ts). */
function router() {
  return new Hono<{ Bindings: Env; Variables: Variables }>()
    .route('/', customObjectLinkDefinitionRoutes)
    .route('/', customObjectsRoutes);
}

function app(...keys: string[]) {
  return createTestApp('/api/custom-objects', router(), {
    context: { tenantDb: db, permissions: permissions(...(keys.length ? keys : ['weldobjects:manage'])) },
  });
}

function send(method: string, path: string, body: unknown, ...keys: string[]) {
  return app(...keys).request(`/api/custom-objects${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/custom-objects · reads', () => {
  it('lists live objects with record and field counts', async () => {
    const res = await app('weldobjects:read').request('/api/custom-objects');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; recordCount: number; fieldCount: number }>;
      pagination: { totalCount: number; hasMore: boolean; cursor: null };
    };
    expect(body.data.map((o) => o.id)).toEqual(['cobj_cert', 'cobj_machine', 'cobj_visit']);
    expect(body.data[1]).toMatchObject({ recordCount: 2, fieldCount: 2 });
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });
  });

  it('filters by status, and refuses a repeated status', async () => {
    const res = await app().request('/api/custom-objects?status=active');
    expect(((await res.json()) as { data: Array<{ id: string }> }).data.map((o) => o.id)).toEqual(['cobj_machine', 'cobj_visit']);
    expect((await app().request('/api/custom-objects?status=active&status=draft')).status).toBe(400);
  });

  it('reads one object with its counts, 404 for a deleted or unknown one', async () => {
    const res = await app('weldobjects:read').request('/api/custom-objects/cobj_cert');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { recordCount: number; fieldCount: number } }).data).toMatchObject({
      recordCount: 1,
      fieldCount: 1,
    });
    expect((await app().request('/api/custom-objects/cobj_retired')).status).toBe(404);
    expect((await app().request('/api/custom-objects/cobj_none')).status).toBe(404);
  });

  it('reports what a delete would destroy, and what blocks it', async () => {
    const res = await app().request('/api/custom-objects/cobj_machine/delete-impact');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { recordCount: 2, fieldCount: 2, linkCount: 3, relationCount: 1, blockedBy: ['Certifications'] },
    });
    expect((await app().request('/api/custom-objects/cobj_none/delete-impact')).status).toBe(404);
    expect((await app('weldobjects:read').request('/api/custom-objects/cobj_machine/delete-impact')).status).toBe(403);
  });

  it('needs weldobjects:read or weldobjects:manage', async () => {
    expect((await app('companies:read').request('/api/custom-objects')).status).toBe(403);
    expect((await app('companies:read').request('/api/custom-objects/cobj_cert')).status).toBe(403);
  });
});

describe('/api/custom-objects · create, update, reorder', () => {
  it('creates an object with defaults', async () => {
    const res = await send('POST', '', { slug: 'vehicle', labelSingular: 'Vehicle', labelPlural: 'Vehicles' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      slug: 'vehicle',
      entityKey: 'co_vehicle',
      icon: 'Box',
      status: 'draft',
      enableEvents: true,
      enableSearch: false,
      listConfig: {},
      sortOrder: 0,
      createdBy: 'user_test_default',
    });
  });

  it('creates an object with every option', async () => {
    const res = await send('POST', '', {
      slug: 'tool_kit',
      labelSingular: 'Tool kit',
      labelPlural: 'Tool kits',
      description: 'Kits in the van',
      icon: 'Wrench',
      color: 'amber',
      status: 'active',
      enableEvents: false,
      enableSearch: true,
      enableAgentTools: true,
      enableExternalApi: true,
      listConfig: { columns: ['title', 'custom:size'], defaultSort: { key: 'title', direction: 'asc' } },
      sortOrder: 7,
    });
    expect(res.status).toBe(201);
  });

  it('refuses a slug in use, or one that belonged to a deleted object', async () => {
    const taken = await send('POST', '', { slug: 'machine', labelSingular: 'M', labelPlural: 'Ms' });
    expect(taken.status).toBe(409);
    const deleted = await send('POST', '', { slug: 'retired', labelSingular: 'R', labelPlural: 'Rs' });
    expect(deleted.status).toBe(409);
    expect(((await deleted.json()) as { error: { message: string } }).error.message).toContain('deleted object');
  });

  it('validates the body', async () => {
    for (const body of [
      { slug: 'company', labelSingular: 'C', labelPlural: 'Cs' },
      { slug: 'Bad Slug', labelSingular: '', labelPlural: 'Xs' },
      { slug: 'a_very_long_slug_over_the_limit', labelSingular: 'X', labelPlural: 'Xs' },
      { slug: 'ok', labelSingular: 'X', labelPlural: 'Xs', status: 'archived', listConfig: { defaultSort: { key: 'x', direction: 'up' } } },
      { labelSingular: 'X' },
    ]) {
      expect((await send('POST', '', body)).status).toBe(400);
    }
  });

  it('needs weldobjects:manage to create', async () => {
    const res = await send('POST', '', { slug: 'nope', labelSingular: 'N', labelPlural: 'Ns' }, 'weldobjects:read');
    expect(res.status).toBe(403);
  });

  it('reorders objects', async () => {
    const res = await send('PUT', '/reorder', {
      items: [
        { id: 'cobj_visit', sortOrder: 0 },
        { id: 'cobj_cert', sortOrder: 3 },
        { id: 'cobj_retired', sortOrder: 0 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { reordered: 3 } });
    expect((await send('PUT', '/reorder', { items: [{ id: 'x' }] })).status).toBe(400);
  });

  it('updates an object, checking its title field', async () => {
    const wrongField = await send('PUT', '/cobj_machine', { titleFieldId: 'cfld_cert_name' });
    expect(wrongField.status).toBe(400);

    const res = await send('PUT', '/cobj_machine', {
      labelPlural: 'Machinery',
      titleFieldId: 'cfld_mach_serial',
      description: null,
      color: null,
      enableSearch: false,
      listConfig: { columns: ['title'] },
      sortOrder: 2,
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      labelPlural: 'Machinery',
      titleFieldId: 'cfld_mach_serial',
      description: null,
      enableSearch: false,
      sortOrder: 2,
    });

    // Clearing the title field.
    const cleared = await send('PUT', '/cobj_machine', { titleFieldId: null });
    expect(cleared.status).toBe(200);
  });

  it('404s an update of an unknown object, and validates the body', async () => {
    expect((await send('PUT', '/cobj_none', { labelPlural: 'X' })).status).toBe(404);
    expect((await send('PUT', '/cobj_machine', { labelPlural: '', sortOrder: 'one' })).status).toBe(400);
  });
});

describe('/api/custom-objects · relationship definitions', () => {
  it('lists link targets: built-ins, then live custom objects', async () => {
    const res = await app().request('/api/custom-objects/link-targets');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ entityType: string; kind: string }> };
    expect(data[0]).toEqual({ entityType: 'company', label: 'Company', kind: 'builtin' });
    expect(data.filter((t) => t.kind === 'custom').map((t) => t.entityType)).toEqual(
      expect.arrayContaining(['co_machine', 'co_certification']),
    );
    expect(data.some((t) => t.entityType === 'co_retired')).toBe(false);
    expect((await app('weldobjects:read').request('/api/custom-objects/link-targets')).status).toBe(403);
  });

  it("lists an object's relationships", async () => {
    const res = await app('weldobjects:read').request('/api/custom-objects/cobj_machine/links');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.map((l) => l.id)).toEqual(['colk_machine_company', 'colk_machine_visits']);
    expect((await app().request('/api/custom-objects/cobj_none/links')).status).toBe(404);
  });

  it('creates a relationship and refuses a duplicate name', async () => {
    const res = await send('POST', '/cobj_visit/links', {
      slug: 'technician_ticket',
      targetEntityKey: 'ticket',
      cardinality: 'many_to_one',
      sourceLabel: 'Visits',
      targetLabel: 'Ticket',
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { onDelete: string; required: boolean; sortOrder: number } };
    expect(data).toMatchObject({ onDelete: 'set_null', required: false, sortOrder: 0 });

    const dup = await send('POST', '/cobj_visit/links', {
      slug: 'technician_ticket',
      targetEntityKey: 'company',
      cardinality: 'one_to_one',
      sourceLabel: 'A',
      targetLabel: 'B',
      onDelete: 'cascade',
      required: true,
      sortOrder: 3,
    });
    expect(dup.status).toBe(409);
  });

  it('refuses a target that is not a live object, or not linkable at all', async () => {
    const missing = await send('POST', '/cobj_visit/links', {
      slug: 'retired',
      targetEntityKey: 'co_retired',
      cardinality: 'many_to_many',
      sourceLabel: 'Visits',
      targetLabel: 'Retired',
    });
    expect(missing.status).toBe(400);
    const builtin = await send('POST', '/cobj_visit/links', {
      slug: 'secrets',
      targetEntityKey: 'weldpass_items',
      cardinality: 'many_to_many',
      sourceLabel: 'Visits',
      targetLabel: 'Secrets',
    });
    expect(builtin.status).toBe(400);
    const empty = await send('POST', '/cobj_visit/links', { slug: 'Bad', targetEntityKey: '', cardinality: 'some', sourceLabel: '', targetLabel: 'x' });
    expect(empty.status).toBe(400);
    const unknown = await send('POST', '/cobj_none/links', {
      slug: 'x',
      targetEntityKey: 'company',
      cardinality: 'many_to_many',
      sourceLabel: 'X',
      targetLabel: 'Y',
    });
    expect(unknown.status).toBe(404);
  });

  it('updates a relationship, scoped to its object', async () => {
    const res = await send('PUT', '/cobj_machine/links/colk_machine_company', {
      targetLabel: 'Owner',
      onDelete: 'cascade',
      required: true,
      sortOrder: 0,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { targetLabel: string } }).data.targetLabel).toBe('Owner');
    expect((await send('PUT', '/cobj_visit/links/colk_machine_company', { targetLabel: 'X' })).status).toBe(404);
    expect((await send('PUT', '/cobj_none/links/colk_machine_company', { targetLabel: 'X' })).status).toBe(404);
    expect((await send('PUT', '/cobj_machine/links/colk_machine_company', { onDelete: 'nothing' })).status).toBe(400);
  });

  it('deletes a relationship with its edges', async () => {
    const res = await app().request('/api/custom-objects/cobj_visit/links/colk_visit_cert', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await app().request('/api/custom-objects/cobj_visit/links/colk_visit_cert', { method: 'DELETE' })).status).toBe(404);
    expect((await app().request('/api/custom-objects/cobj_none/links/colk_visit_cert', { method: 'DELETE' })).status).toBe(404);
  });

  it('needs weldobjects:manage to change relationships', async () => {
    const body = { slug: 'x', targetEntityKey: 'company', cardinality: 'many_to_many', sourceLabel: 'X', targetLabel: 'Y' };
    expect((await send('POST', '/cobj_visit/links', body, 'weldobjects:read')).status).toBe(403);
    expect((await send('PUT', '/cobj_machine/links/colk_machine_company', { targetLabel: 'X' }, 'weldobjects:read')).status).toBe(403);
    expect(
      (await app('weldobjects:read').request('/api/custom-objects/cobj_machine/links/colk_machine_company', { method: 'DELETE' })).status,
    ).toBe(403);
  });
});

describe('/api/custom-objects · delete', () => {
  it('asks for confirmation, naming what would be destroyed', async () => {
    const res = await app().request('/api/custom-objects/cobj_cert', { method: 'DELETE' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; details: Record<string, number> } };
    expect(body.error.details).toEqual({ recordCount: 1, fieldCount: 1, linkCount: 1, relationCount: 1 });
    const wrong = await app().request('/api/custom-objects/cobj_cert?confirm=machine', { method: 'DELETE' });
    expect(wrong.status).toBe(400);
  });

  it('refuses while a restricting relationship holds edges', async () => {
    const res = await app().request('/api/custom-objects/cobj_machine?confirm=machine', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({ blockedBy: ['Certifications'] });
  });

  it('deletes an object and everything hanging off it', async () => {
    const res = await app().request('/api/custom-objects/cobj_cert?confirm=certification', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [record] = await db.select().from(schema.customObjectRecords).where(eq(schema.customObjectRecords.id, 'cor_cert_1'));
    expect(record!.deletedAt).not.toBeNull();
    expect(await db.select().from(schema.customFieldValues).where(eq(schema.customFieldValues.entityId, 'cor_cert_1'))).toHaveLength(0);
    expect((await app().request('/api/custom-objects/cobj_cert')).status).toBe(404);
    expect((await app().request('/api/custom-objects/cobj_cert?confirm=certification', { method: 'DELETE' })).status).toBe(404);

    // The edge that blocked the machine went with it.
    const impact = await app().request('/api/custom-objects/cobj_machine/delete-impact');
    expect(((await impact.json()) as { data: { blockedBy: string[] } }).data.blockedBy).toEqual([]);
  });

  it('needs weldobjects:manage to delete', async () => {
    expect((await app('weldobjects:read').request('/api/custom-objects/cobj_visit?confirm=visit', { method: 'DELETE' })).status).toBe(403);
  });
});
