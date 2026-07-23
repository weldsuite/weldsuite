/**
 * DB-backed tests for the shared custom-field VALUES helpers that Pile B relies
 * on outside app-api (workflow attribute handlers, the backfill): the
 * auto-create definition policy and the person/conversation value round-trip.
 *
 * Runs against the app-api pglite harness because it is the only one wired up;
 * the functions themselves live in @weldsuite/db/lib and are runtime-agnostic.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import {
  ensureCustomFieldDefinition,
  setValues,
  getValuesForEntity,
} from '@weldsuite/db/lib/custom-field-values';

const cfd = schema.customFieldDefinitions;

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('ensureCustomFieldDefinition (Pile B auto-create)', () => {
  it('creates a text definition when the attribute has none', async () => {
    const def = await ensureCustomFieldDefinition(db, generateId, 'person', 'lead_source');
    expect(def.entityType).toBe('person');
    expect(def.slug).toBe('lead_source');
    expect(def.fieldType).toBe('text');
    expect(def.ticketTypeId).toBeNull();

    const rows = await db
      .select()
      .from(cfd)
      .where(and(eq(cfd.entityType, 'person'), eq(cfd.slug, 'lead_source'), isNull(cfd.deletedAt)));
    expect(rows.length).toBe(1);
  });

  it('returns the existing definition without duplicating or retyping it', async () => {
    // Seed a non-text definition, then ensure must return it as-is.
    const seeded = await ensureCustomFieldDefinition(db, generateId, 'conversation', 'csat');
    await db.update(cfd).set({ fieldType: 'number' }).where(eq(cfd.id, seeded.id));

    const again = await ensureCustomFieldDefinition(db, generateId, 'conversation', 'csat');
    expect(again.id).toBe(seeded.id);
    expect(again.fieldType).toBe('number'); // not forced back to text

    const rows = await db
      .select()
      .from(cfd)
      .where(and(eq(cfd.entityType, 'conversation'), eq(cfd.slug, 'csat'), isNull(cfd.deletedAt)));
    expect(rows.length).toBe(1); // no duplicate
  });

  it('round-trips a workflow attribute value through the typed store', async () => {
    const def = await ensureCustomFieldDefinition(db, generateId, 'person', 'region');
    await setValues(db, 'person', 'per_workflow_1', { region: 'EU' }, {
      generateId,
      definitions: [def],
    });
    const values = await getValuesForEntity(db, 'person', 'per_workflow_1', [def]);
    expect(values.region).toBe('EU');
  });
});
