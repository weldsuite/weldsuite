/**
 * DB-backed tests for an entity's document numbering: reading the sequences,
 * continuing a series from another package, and the forward-only next number.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { accountingEntitiesRoutes } from './index';
import { nextEntityNumber } from '../../lib/entity-context';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

function request(path: string, init?: { method?: string; body?: unknown; perms?: string[] }) {
  const { request: send } = createTestApp('/api/accounting-entities', accountingEntitiesRoutes, {
    context: {
      permissions: permissions(...(init?.perms ?? ['entities:read', 'entities:create', 'entities:update'])),
      tenantDb: db,
    },
  });
  return send(path, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function createEntity(name: string): Promise<string> {
  const res = await request('/api/accounting-entities', {
    method: 'POST',
    body: { name, jurisdictionCode: 'NL', seedDefaults: false },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

interface Sequence {
  sequenceType: string;
  prefix: string;
  nextValue: number;
  padding: number;
  nextNumber: string;
}

async function sequences(res: Response): Promise<Record<string, Sequence>> {
  const body = (await res.json()) as { data: Sequence[] };
  return Object.fromEntries(body.data.map((s) => [s.sequenceType, s]));
}

function patch(id: string, list: unknown[], perms?: string[]) {
  return request(`/api/accounting-entities/${id}/number-sequences`, { method: 'PATCH', body: { sequences: list }, perms });
}

describe('/api/accounting-entities/:id/number-sequences', () => {
  it('lists the four sequences an entity is created with', async () => {
    const id = await createEntity('Numbering List BV');
    const res = await request(`/api/accounting-entities/${id}/number-sequences`);
    expect(res.status).toBe(200);
    const list = await sequences(res);
    expect(Object.keys(list).sort()).toEqual(['bill', 'creditNote', 'invoice', 'journal']);
    expect(list.invoice).toMatchObject({ prefix: 'INV-', nextValue: 1 });
    expect(list.invoice.nextNumber).toBe(`INV-${'1'.padStart(list.invoice.padding, '0')}`);
  });

  it('continues a series: the next invoice gets the number that was set', async () => {
    const id = await createEntity('Numbering Continue BV');
    const res = await patch(id, [{ sequenceType: 'invoice', prefix: '2026-', nextValue: 1001, padding: 0 }]);
    expect(res.status).toBe(200);
    expect((await sequences(res)).invoice).toMatchObject({ prefix: '2026-', nextValue: 1001, nextNumber: '2026-1001' });

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, id), eq(schema.auditLog.action, 'numbering_updated')));
    expect(audit).toHaveLength(1);
    expect(audit[0].changes).toMatchObject({ 'invoice.nextValue': { old: 1, new: 1001 } });

    const issued = await nextEntityNumber(db, id, 'invoice');
    expect(issued.formatted).toBe('2026-1001');
    const after = await sequences(await request(`/api/accounting-entities/${id}/number-sequences`));
    expect(after.invoice.nextNumber).toBe('2026-1002');
  });

  it('refuses to move the next number back, so no number is handed out twice', async () => {
    const id = await createEntity('Numbering Back BV');
    await nextEntityNumber(db, id, 'invoice');
    await nextEntityNumber(db, id, 'invoice'); // next is now 3

    const back = await patch(id, [{ sequenceType: 'invoice', nextValue: 2 }]);
    expect(back.status).toBe(400);
    expect(((await back.json()) as { error: { message: string } }).error.message).toMatch(/only move forward/);

    // A prefix change leaves the next number where it is.
    const prefix = await patch(id, [{ sequenceType: 'invoice', prefix: 'F' }]);
    expect(prefix.status).toBe(200);
    expect((await sequences(prefix)).invoice).toMatchObject({ prefix: 'F', nextValue: 3 });
  });

  it('writes nothing when one sequence of the request would move back', async () => {
    const id = await createEntity('Numbering Partial BV');
    await nextEntityNumber(db, id, 'journal');
    await nextEntityNumber(db, id, 'journal'); // next is now 3

    const res = await patch(id, [
      { sequenceType: 'invoice', prefix: '2026-' },
      { sequenceType: 'journal', nextValue: 2 },
    ]);
    expect(res.status).toBe(400);

    const list = await sequences(await request(`/api/accounting-entities/${id}/number-sequences`));
    expect(list.invoice.prefix).toBe('INV-');
    expect(list.journal.nextValue).toBe(3);
  });

  it('creates a sequence that has no row yet', async () => {
    const id = await createEntity('Numbering Missing BV');
    // Entities created before sequences were seeded have none; mimic that for bills.
    await db
      .delete(schema.entityNumberSequences)
      .where(and(eq(schema.entityNumberSequences.entityId, id), eq(schema.entityNumberSequences.sequenceType, 'bill')));

    const res = await patch(id, [{ sequenceType: 'bill', nextValue: 50 }]);
    expect(res.status).toBe(200);
    expect((await sequences(res)).bill).toMatchObject({ prefix: 'BILL-', nextValue: 50 });
  });

  it('validates the input and the permission', async () => {
    const id = await createEntity('Numbering Invalid BV');
    expect((await patch(id, [{ sequenceType: 'invoice', prefix: 'INV<script>' }])).status).toBe(400);
    expect((await patch(id, [{ sequenceType: 'invoice', nextValue: 0 }])).status).toBe(400);
    expect((await patch(id, [{ sequenceType: 'quote', nextValue: 5 }])).status).toBe(400);
    expect((await patch(id, [{ sequenceType: 'invoice' }, { sequenceType: 'invoice' }])).status).toBe(400);
    expect((await patch(id, [{ sequenceType: 'invoice', nextValue: 5 }], ['entities:read'])).status).toBe(403);
    expect((await patch('ent_missing', [{ sequenceType: 'invoice', nextValue: 5 }])).status).toBe(404);
  });
});
