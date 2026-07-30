/**
 * pglite-backed tests for the `search_index` table created by tenant
 * migration 0175.
 *
 * These assert the things a migration passing without error does NOT prove:
 * that the pgvector extension is actually usable, that the `vector(1024)`
 * column round-trips through Drizzle, that cosine distance orders results the
 * way the semantic leg will rely on, and that the uniqueness constraint on
 * (entity_type, entity_id, chunk_index) really holds.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

/** bge-m3 emits 1024 dims; the column is declared to match exactly. */
const DIMS = 1024;

/** A unit vector pointing at a single axis — trivially reasoned about. */
function axisVector(axis: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[axis] = 1;
  return v;
}

let rowCounter = 0;
function insertRow(entityId: string, embedding: number[], content: string) {
  rowCounter += 1;
  return db.insert(schema.searchIndex).values({
    id: `si_test_${rowCounter}`,
    entityType: 'invoice',
    entityId,
    chunkIndex: 0,
    content,
    contentHash: `hash_${rowCounter}`,
    embedding,
    embedModel: '@cf/baai/bge-m3',
    title: content,
    url: `/weldbooks/invoices/${entityId}`,
  });
}

describe('search_index (tenant migration 0175)', () => {
  it('round-trips a 1024-dimension embedding through Drizzle', async () => {
    await insertRow('inv_roundtrip', axisVector(0), 'Acme Corp invoice');

    const [row] = await db
      .select()
      .from(schema.searchIndex)
      .where(eq(schema.searchIndex.entityId, 'inv_roundtrip'));

    expect(row).toBeDefined();
    expect(row!.embedding).toHaveLength(DIMS);
    expect(row!.embedding![0]).toBe(1);
    expect(row!.embedModel).toBe('@cf/baai/bge-m3');
  });

  it('orders by cosine distance, which is what the semantic leg queries on', async () => {
    await insertRow('inv_near', axisVector(1), 'near match');
    await insertRow('inv_far', axisVector(2), 'far match');

    // Query vector identical to inv_near's — distance 0 there, 1 to inv_far.
    const probe = JSON.stringify(axisVector(1));
    const rows = await db
      .select({
        entityId: schema.searchIndex.entityId,
        distance: sql<number>`${schema.searchIndex.embedding} <=> ${probe}::vector`,
      })
      .from(schema.searchIndex)
      .where(
        and(
          eq(schema.searchIndex.entityType, 'invoice'),
          sql`${schema.searchIndex.entityId} IN ('inv_near', 'inv_far')`,
        ),
      )
      .orderBy(sql`${schema.searchIndex.embedding} <=> ${probe}::vector`);

    expect(rows.map((r) => r.entityId)).toEqual(['inv_near', 'inv_far']);
    expect(Number(rows[0]!.distance)).toBeCloseTo(0, 5);
    expect(Number(rows[1]!.distance)).toBeCloseTo(1, 5);
  });

  it('rejects a duplicate chunk for the same entity', async () => {
    await insertRow('inv_dupe', axisVector(3), 'first');
    await expect(insertRow('inv_dupe', axisVector(4), 'second')).rejects.toThrow();
  });

  it('allows several chunks of one entity to coexist', async () => {
    await db.insert(schema.searchIndex).values([
      {
        id: 'si_chunk_a',
        entityType: 'knowledge_page',
        entityId: 'kp_multi',
        chunkIndex: 0,
        content: 'chunk zero',
        contentHash: 'h0',
        embedding: axisVector(5),
        embedModel: '@cf/baai/bge-m3',
      },
      {
        id: 'si_chunk_b',
        entityType: 'knowledge_page',
        entityId: 'kp_multi',
        chunkIndex: 1,
        content: 'chunk one',
        contentHash: 'h1',
        embedding: axisVector(6),
        embedModel: '@cf/baai/bge-m3',
      },
    ]);

    const rows = await db
      .select()
      .from(schema.searchIndex)
      .where(eq(schema.searchIndex.entityId, 'kp_multi'));

    expect(rows).toHaveLength(2);
  });

  it('permits a null embedding so a row can be queued before it is embedded', async () => {
    await db.insert(schema.searchIndex).values({
      id: 'si_pending',
      entityType: 'ticket',
      entityId: 'tkt_pending',
      chunkIndex: 0,
      content: 'awaiting embedding',
      contentHash: 'h_pending',
      embedModel: '@cf/baai/bge-m3',
    });

    const [row] = await db
      .select()
      .from(schema.searchIndex)
      .where(eq(schema.searchIndex.entityId, 'tkt_pending'));

    expect(row!.embedding).toBeNull();
  });
});
