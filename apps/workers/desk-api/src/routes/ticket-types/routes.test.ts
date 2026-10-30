/**
 * Every /api/ticket-types route on pglite: the shared CRUD suite
 * (../../test/crud-suite.ts) plus the `fields` sync into
 * custom_field_definitions on create and update. Runs against Rust in
 * conformance mode; the definition rows read here are the Rust run's.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { ticketTypesRoutes } from './index';

const BASE = '/api/ticket-types';
const t = schema.helpdeskTicketTypes;
const defs = schema.customFieldDefinitions;

describeCrud(BASE, {
  base: BASE,
  routes: ticketTypesRoutes,
  table: t,
  gates: { read: 'tickets:read', create: 'tickets:create', update: 'tickets:update', delete: 'tickets:delete' },
  seed: (n) => ({ name: `Type ${n}` }),
  valid: { name: 'Bug Report', color: '#ef4444', icon: 'AlertTriangle', sortOrder: 0, isActive: true, description: 'Bugs' },
  // The schema allows a 100-character icon, the column 50.
  unstorable: { name: 'Too iconic', icon: 'x'.repeat(60) },
  invalid: [
    {},
    { name: '' },
    { name: 'x'.repeat(101) },
    { name: 'x', isActive: 'yes' },
    { name: 'x', sortOrder: 1.5 },
    { name: 'x', color: 'x'.repeat(51) },
    { name: 'x', description: 5 },
  ],
  patch: { name: 'Incident', description: 'Something broke' },
  invalidPatch: { isActive: 'no' },
  filters: [{ query: 'search=Needle', match: { name: 'Needle type' } }],
});

describe('/api/ticket-types · fields sync into custom_field_definitions', () => {
  // createPgliteDb() is one database per file: the CRUD suite's rows are here too.
  let db: Database;
  const app = (...keys: string[]) =>
    createTestApp(BASE, ticketTypesRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });
  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const at = (second: number) => new Date(Date.UTC(2026, 0, 3, 12, 0, second));
  const row = async (id: string) => (await db.select().from(t).where(eq(t.id, id)).limit(1))[0];
  const definitions = (ticketTypeId: string) =>
    db
      .select()
      .from(defs)
      .where(and(eq(defs.entityType, 'ticket'), eq(defs.ticketTypeId, ticketTypeId)))
      .orderBy(asc(defs.slug));
  const live = async (ticketTypeId: string) => (await definitions(ticketTypeId)).filter((d) => d.deletedAt === null);

  async function create(body: Record<string, unknown>): Promise<string> {
    const res = await app('tickets:create').request(BASE, json(body));
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    await db.insert(t).values({ id: 'tty_plain', name: 'Plain', createdAt: at(1), updatedAt: at(1) });
  }, 60_000);

  it('GET /:id answers the row with its defaults; 404 names the ticket type', async () => {
    const { request } = app('tickets:read');
    const res = await request(`${BASE}/tty_plain`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toMatchObject({
      id: 'tty_plain',
      name: 'Plain',
      category: 'customer',
      fields: null,
      states: null,
      disableAiAutofill: false,
      sortOrder: 0,
      isActive: true,
      deletedAt: null,
    });
    const missing = await request(`${BASE}/nope_missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: 'NOT_FOUND', message: "Ticket type with ID 'nope_missing' not found" },
    });
  });

  it('POST / mirrors the custom fields; defaults, keyless and empty entries are skipped', async () => {
    const fields = [
      {
        key: 'severity',
        label: 'Severity',
        type: 'select',
        required: true,
        order: 0,
        options: [
          { label: 'Low', value: 'low' },
          { label: 'High', value: 'high', color: 'red' },
        ],
      },
      { key: 'steps', label: 'Steps to reproduce', type: 'textarea', required: false, order: 1 },
      { key: 'subject', label: 'Subject', type: 'text', required: true, order: 2, isDefault: true },
      { key: '', label: 'No key', type: 'text', required: false, order: 3 },
      null,
      { key: 'agreed', label: 'Agreed', type: 'checkbox' },
      { key: 'tags', label: 'Tags', type: 'multiselect', required: false, order: 5, options: [] },
      { key: 'odd', label: 'Odd', type: 'weird', required: false, order: 6 },
      { key: 'when', label: 'When', type: 'date', required: false, order: 7 },
      { key: 'qty', label: 'Quantity', type: 'number', required: false, order: 8 },
      { key: 'mail', label: 'Mail', type: 'email', required: false, order: 9 },
      { key: 'site', label: 'Site', type: 'url', required: false, order: 10 },
    ];
    const id = await create({ name: 'Bug', fields });
    expect(id).toMatch(/^tty_/);
    expect((await row(id))?.fields).toEqual(fields);

    const rows = await live(id);
    expect(rows.map((d) => [d.slug, d.name, d.fieldType, d.required, d.sortOrder, d.options])).toEqual([
      ['agreed', 'Agreed', 'boolean', false, 0, null],
      ['mail', 'Mail', 'email', false, 9, null],
      ['odd', 'Odd', 'text', false, 6, null],
      ['qty', 'Quantity', 'number', false, 8, null],
      [
        'severity',
        'Severity',
        'single_select',
        true,
        0,
        [
          { label: 'Low', value: 'low' },
          // Only label and value are copied.
          { label: 'High', value: 'high' },
        ],
      ],
      ['site', 'Site', 'url', false, 10, null],
      ['steps', 'Steps to reproduce', 'textarea', false, 1, null],
      ['tags', 'Tags', 'multi_select', false, 5, null],
      ['when', 'When', 'date', false, 7, null],
    ]);
    expect(rows.every((d) => d.id.startsWith('cfld_') && d.ticketTypeId === id && d.entityType === 'ticket')).toBe(
      true,
    );
  });

  it('PATCH /:id with fields updates in place, adds new ones and retires removed ones', async () => {
    const id = await create({
      name: 'Request',
      fields: [
        { key: 'urgency', label: 'Urgency', type: 'text', required: false, order: 0 },
        { key: 'dept', label: 'Department', type: 'text', required: false, order: 1 },
      ],
    });
    const before = await live(id);
    const urgencyId = before.find((d) => d.slug === 'urgency')?.id;

    const res = await app('tickets:update').request(
      `${BASE}/${id}`,
      json(
        {
          fields: [
            { key: 'urgency', label: 'How urgent', type: 'select', required: true, order: 4, options: [{ label: 'Now', value: 'now' }] },
            { key: 'browser', label: 'Browser', type: 'text', required: false, order: 5 },
          ],
        },
        'PATCH',
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id } });

    const after = await live(id);
    expect(after.map((d) => [d.slug, d.name, d.fieldType, d.required, d.sortOrder])).toEqual([
      ['browser', 'Browser', 'text', false, 5],
      ['urgency', 'How urgent', 'single_select', true, 4],
    ]);
    expect(after.find((d) => d.slug === 'urgency')?.id).toBe(urgencyId);
    expect(after.find((d) => d.slug === 'urgency')?.options).toEqual([{ label: 'Now', value: 'now' }]);
    const retired = (await definitions(id)).find((d) => d.slug === 'dept');
    expect(retired?.deletedAt).toBeInstanceOf(Date);
  });

  it('PATCH /:id without fields leaves the definitions; fields: null or [] retires them all', async () => {
    const one = await create({
      name: 'Keep',
      fields: [{ key: 'model', label: 'Model', type: 'text', required: false, order: 0 }],
    });
    const { request } = app('tickets:update');
    expect((await request(`${BASE}/${one}`, json({ name: 'Kept' }, 'PATCH'))).status).toBe(200);
    expect((await live(one)).map((d) => d.slug)).toEqual(['model']);

    expect((await request(`${BASE}/${one}`, json({ fields: null }, 'PATCH'))).status).toBe(200);
    expect(await live(one)).toEqual([]);
    expect((await row(one))?.fields).toBeNull();

    const two = await create({
      name: 'Empty',
      fields: [{ key: 'os', label: 'OS', type: 'text', required: false, order: 0 }],
    });
    expect((await request(`${BASE}/${two}`, json({ fields: [] }, 'PATCH'))).status).toBe(200);
    expect(await live(two)).toEqual([]);
    expect((await row(two))?.fields).toEqual([]);
  });

  it('a create without fields writes no definitions', async () => {
    const id = await create({ name: 'No fields' });
    expect(await definitions(id)).toEqual([]);
  });

  it('a failing sync never fails the write: fields that are not a list, a label the column cannot hold', async () => {
    const notAList = await create({ name: 'Odd fields', fields: 'not-a-list' });
    expect((await row(notAList))?.fields).toBe('not-a-list');
    expect(await definitions(notAList)).toEqual([]);

    const longLabel = await create({
      name: 'Long label',
      fields: [{ key: 'long', label: 'x'.repeat(101), type: 'text', required: false, order: 0 }],
    });
    expect(await definitions(longLabel)).toEqual([]);

    const res = await app('tickets:update').request(`${BASE}/${notAList}`, json({ fields: { key: 'x' } }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(await definitions(notAList)).toEqual([]);
  });

  it('PATCH /:id and DELETE /:id 404 name the ticket type', async () => {
    const { request } = app('tickets:update', 'tickets:delete');
    const patch = await request(`${BASE}/nope_missing`, json({ name: 'x' }, 'PATCH'));
    expect(await patch.json()).toEqual({
      error: { code: 'NOT_FOUND', message: "Ticket type with ID 'nope_missing' not found" },
    });
    expect((await request(`${BASE}/tty_plain`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`${BASE}/tty_plain`, json({ name: 'x' }, 'PATCH'))).status).toBe(404);
  });
});
