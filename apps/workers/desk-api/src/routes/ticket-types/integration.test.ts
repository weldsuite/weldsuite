/**
 * DB-backed tests of the ticket-type → custom_field_definitions sync helper.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { getDefinitionsForTicket, setValues } from '@weldsuite/core-domain/custom-field-values';
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

// The pure sync helper and scoped resolution, directly against pglite. The
// routes themselves (and the sync they run) are in ./routes.test.ts.
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
    expect(await activeTicketDefs(db, typeId)).toHaveLength(2);

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
