/**
 * POST /api/objects/:slug/records/import: a batch of records created like
 * single creates (validation, titles, owner, `co_<slug>:created` events),
 * with refused rows reported by position instead of failing the batch.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { customObjectRecordsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

let db: Database;

const day = new Date('2026-07-01T09:00:00.000Z');
const URL = '/api/objects/gadget/records/import';

const app = (keys: string[]) =>
  createTestApp('/api/objects', customObjectRecordsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db },
  });

const post = (body: unknown, keys = ['weldobjects:gadget:create'], url = URL) =>
  app(keys).request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const gadgets = () =>
  db
    .select()
    .from(schema.customObjectRecords)
    .where(and(eq(schema.customObjectRecords.entityKey, 'co_gadget'), isNull(schema.customObjectRecords.deletedAt)))
    .orderBy(asc(schema.customObjectRecords.title));

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.customObjects).values({
    id: 'cobj_gadget',
    slug: 'gadget',
    entityKey: 'co_gadget',
    labelSingular: 'Gadget',
    labelPlural: 'Gadgets',
    status: 'active',
    titleFieldId: 'cfld_gadget_label',
    createdAt: day,
    updatedAt: day,
  });
  await db.insert(schema.customFieldDefinitions).values([
    { id: 'cfld_gadget_label', entityType: 'co_gadget', name: 'Label', slug: 'label', fieldType: 'text', required: true, sortOrder: 0, createdAt: day, updatedAt: day },
    { id: 'cfld_gadget_weight', entityType: 'co_gadget', name: 'Weight', slug: 'weight', fieldType: 'number', sortOrder: 1, createdAt: day, updatedAt: day },
    {
      id: 'cfld_gadget_kind',
      entityType: 'co_gadget',
      name: 'Kind',
      slug: 'kind',
      fieldType: 'single_select',
      options: [
        { label: 'Small', value: 'small' },
        { label: 'Large', value: 'large' },
      ],
      sortOrder: 2,
      createdAt: day,
      updatedAt: day,
    },
    { id: 'cfld_gadget_bought', entityType: 'co_gadget', name: 'Bought', slug: 'bought', fieldType: 'date', sortOrder: 3, createdAt: day, updatedAt: day },
  ]);
  // Events off: the import must honour the switch like a single create does.
  await db.insert(schema.customObjects).values({
    id: 'cobj_quiet',
    slug: 'quiet',
    entityKey: 'co_quiet',
    labelSingular: 'Quiet',
    labelPlural: 'Quiets',
    status: 'active',
    enableEvents: false,
    createdAt: day,
    updatedAt: day,
  });
  await db.insert(schema.customFieldDefinitions).values({
    id: 'cfld_quiet_note',
    entityType: 'co_quiet',
    name: 'Note',
    slug: 'note',
    fieldType: 'text',
    sortOrder: 0,
    createdAt: day,
    updatedAt: day,
  });
}, 60_000);

describe('POST /api/objects/:slug/records/import', () => {
  it('creates the valid rows and reports the refused ones by position', async () => {
    const res = await post({
      rows: [
        { fields: { label: 'Drill', weight: 2.5, kind: 'small', bought: '2026-03-01' } },
        { fields: { weight: 4 } },
        { fields: { label: 'Saw', kind: 'huge' } },
        { fields: { label: 'Lathe', bought: 'not a date' } },
        { fields: { label: 'Press', kind: 'large' }, ownerId: 'user_other' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { created: number; errors: { row: number; message: string }[] } };
    expect(body.data).toEqual({
      created: 2,
      errors: [
        { row: 2, message: "'label' is required" },
        { row: 3, message: "'huge' is not a valid option for 'kind'" },
        { row: 4, message: "'bought' must be a valid date" },
      ],
    });

    const rows = await gadgets();
    expect(rows.map((r) => [r.title, r.ownerId, r.createdBy])).toEqual([
      ['Drill', 'user_test_default', 'user_test_default'],
      ['Press', 'user_other', 'user_test_default'],
    ]);
    // A refused row leaves nothing behind.
    const values = await db
      .select()
      .from(schema.customFieldValues)
      .where(eq(schema.customFieldValues.entityType, 'co_gadget'));
    expect(values).toHaveLength(6);
  });

  it('imports into an object with events switched off', async () => {
    const res = await post(
      { rows: [{ fields: { note: 'one' } }, { fields: { note: 'two' } }] },
      ['weldobjects:quiet:create'],
      '/api/objects/quiet/records/import',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { created: number } };
    expect(body.data.created).toBe(2);
  });

  it('needs the create permission of the object', async () => {
    const res = await post({ rows: [{ fields: { label: 'Nope' } }] }, ['weldobjects:gadget:read']);
    expect(res.status).toBe(403);
  });

  it('answers 404 for an object that does not exist', async () => {
    const res = await post({ rows: [{ fields: {} }] }, ['weldobjects:*'], '/api/objects/nothing/records/import');
    expect(res.status).toBe(404);
  });

  it.each([
    ['no rows', { rows: [] }],
    ['more than 200 rows', { rows: Array.from({ length: 201 }, () => ({ fields: { label: 'x' } })) }],
    ['a row that is not an object', { rows: ['Drill'] }],
    ['fields that are not an object', { rows: [{ fields: 'Drill' }] }],
    ['no body', {}],
  ])('refuses %s', async (_label, body) => {
    const before = (await gadgets()).length;
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await gadgets()).toHaveLength(before);
  });
});
