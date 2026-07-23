/**
 * DB-backed integration tests for /api/ticket-types.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { ticketTypesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { getDefinitionsForTicket, setValues } from '../../services/custom-field-values';
import { syncTicketTypeDefinitions } from '@weldsuite/db/lib/custom-field-ticket-types';

const cfd = schema.customFieldDefinitions;
const cfv = schema.customFieldValues;

async function activeTicketDefs(db: Database, ticketTypeId: string) {
  return db
    .select()
    .from(cfd)
    .where(and(eq(cfd.entityType, 'ticket'), eq(cfd.ticketTypeId, ticketTypeId), isNull(cfd.deletedAt)));
}

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/ticket-types · pglite integration', () => {
  it('POST / writes a ticket-type row', async () => {
    const { request } = createTestApp('/api/ticket-types', ticketTypesRoutes, {
      context: { permissions: permissions('tickets:create'), tenantDb: db },
    });

    const res = await request('/api/ticket-types', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bug Report',
        color: '#ef4444',
        icon: 'AlertTriangle',
        sortOrder: 0,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBeTruthy();

    const [row] = await db
      .select()
      .from(schema.helpdeskTicketTypes)
      .where(eq(schema.helpdeskTicketTypes.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Bug Report');
    expect(row?.color).toBe('#ef4444');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/ticket-types', ticketTypesRoutes, {
      context: { permissions: permissions('tickets:create'), tenantDb: db },
    });
    const res = await request('/api/ticket-types', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });
});

// Tests the pure sync helper + scoped resolution directly against pglite. It
// does NOT drive the HTTP route: that route 500s in this harness on the shared
// publishEntityEvent/executionCtx limitation (the original POST test above is
// already red for the same reason), which is unrelated to Pile B.
describe('ticket-type → custom_field_definitions sync (Pile B)', () => {
  it('mirrors non-default fields into scoped definitions', async () => {
    const typeId = generateId('tty');
    await syncTicketTypeDefinitions(db, generateId, typeId, [
      { key: 'severity', label: 'Severity', type: 'select', required: true, order: 0,
        options: [{ label: 'Low', value: 'low' }, { label: 'High', value: 'high' }] },
      { key: 'steps', label: 'Steps to reproduce', type: 'textarea', required: false, order: 1 },
      // isDefault fields map to real columns, not the blob — must be skipped.
      { key: 'subject', label: 'Subject', type: 'text', required: true, order: 2, isDefault: true },
    ]);

    const bySlug = new Map((await activeTicketDefs(db, typeId)).map((d) => [d.slug, d]));
    expect(bySlug.size).toBe(2);
    expect(bySlug.get('subject')).toBeUndefined(); // default skipped
    expect(bySlug.get('severity')?.fieldType).toBe('single_select');
    expect(bySlug.get('severity')?.required).toBe(true);
    expect(bySlug.get('severity')?.ticketTypeId).toBe(typeId);
    expect((bySlug.get('severity')?.options ?? []).map((o) => o.value)).toEqual(['low', 'high']);
    expect(bySlug.get('steps')?.fieldType).toBe('textarea');
  });

  it('is idempotent and soft-deletes definitions for removed fields', async () => {
    const typeId = generateId('tty');
    await syncTicketTypeDefinitions(db, generateId, typeId, [
      { key: 'urgency', label: 'Urgency', type: 'text', required: false, order: 0 },
      { key: 'dept', label: 'Department', type: 'text', required: false, order: 1 },
    ]);
    expect((await activeTicketDefs(db, typeId)).length).toBe(2);

    // Re-sync with `dept` removed and `urgency` relabeled.
    await syncTicketTypeDefinitions(db, generateId, typeId, [
      { key: 'urgency', label: 'How urgent', type: 'text', required: true, order: 0 },
    ]);

    const remaining = await activeTicketDefs(db, typeId);
    expect(remaining.map((d) => d.slug)).toEqual(['urgency']);
    expect(remaining[0].name).toBe('How urgent'); // updated in place, not duplicated
    expect(remaining[0].required).toBe(true);
  });

  it('resolves a shared slug to the right definition per ticket type', async () => {
    // Two types both define `priority` — same slug, different definitions.
    const typeA = generateId('tty');
    const typeB = generateId('tty');
    await syncTicketTypeDefinitions(db, generateId, typeA, [
      { key: 'priority', label: 'Priority A', type: 'text', required: false, order: 0 },
    ]);
    await syncTicketTypeDefinitions(db, generateId, typeB, [
      { key: 'priority', label: 'Priority B', type: 'text', required: false, order: 0 },
    ]);

    const defsA = await getDefinitionsForTicket(db, typeA);
    const defsB = await getDefinitionsForTicket(db, typeB);
    const defA = defsA.find((d) => d.slug === 'priority')!;
    const defB = defsB.find((d) => d.slug === 'priority')!;
    expect(defA.id).not.toBe(defB.id); // distinct definitions, shared slug

    // A value written for a type-A ticket must key on type-A's definition.
    await setValues(db, 'ticket', 'tkt_shared_a', { priority: 'urgent' }, { definitions: defsA });
    const [row] = await db
      .select()
      .from(cfv)
      .where(and(eq(cfv.entityType, 'ticket'), eq(cfv.entityId, 'tkt_shared_a')));
    expect(row?.fieldId).toBe(defA.id);
    expect(row?.fieldId).not.toBe(defB.id);
    expect(row?.valueText).toBe('urgent');
  });
});
