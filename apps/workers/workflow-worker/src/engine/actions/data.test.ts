import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  handleCreateRecord,
  handleUpdateRecord,
  handleDeleteRecord,
  handleQueryData,
  handleTransform,
} from './data';
import { makeActionContext } from '../../test/ctx';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

// --- transform: pure, no db -------------------------------------------------

describe('transform', () => {
  const ctx = makeActionContext({ previousResults: { a: 1, b: 2 } });

  it('pick selects the requested fields', async () => {
    const res = await handleTransform({ transform: 'pick', data: { x: 1, y: 2, z: 3 }, fields: ['x', 'z'] }, ctx);
    expect(res).toEqual({ x: 1, z: 3 });
  });

  it('pick defaults data to ctx.previousResults', async () => {
    const res = await handleTransform({ transform: 'pick', fields: ['a'] }, ctx);
    expect(res).toEqual({ a: 1 });
  });

  it('pick throws without a fields array', async () => {
    await expect(handleTransform({ transform: 'pick', data: {} }, ctx)).rejects.toThrow(/fields/i);
  });

  it('map projects a field from each array item', async () => {
    const res = await handleTransform(
      { transform: 'map', source: [{ id: 1 }, { id: 2 }], mapField: 'id' },
      ctx,
    );
    expect(res).toEqual([1, 2]);
  });

  it('map throws when source is not an array', async () => {
    await expect(handleTransform({ transform: 'map', source: {} }, ctx)).rejects.toThrow(/array/i);
  });

  it('filter keeps items whose field equals the value', async () => {
    const res = await handleTransform(
      { transform: 'filter', source: [{ s: 'a' }, { s: 'b' }], filterField: 's', filterValue: 'b' },
      ctx,
    );
    expect(res).toEqual([{ s: 'b' }]);
  });

  it('merge combines objects', async () => {
    const res = await handleTransform({ transform: 'merge', objects: [{ a: 1 }, { b: 2 }] }, ctx);
    expect(res).toEqual({ a: 1, b: 2 });
  });

  it('stringify and parse round-trip', async () => {
    const str = await handleTransform({ transform: 'stringify', data: { a: 1 } }, ctx);
    expect(str).toBe('{"a":1}');
    const parsed = await handleTransform({ transform: 'parse', data: '{"a":1}' }, ctx);
    expect(parsed).toEqual({ a: 1 });
  });
});

// --- record CRUD: pglite ----------------------------------------------------

describe('record actions (pglite)', () => {
  let db: Database;

  beforeAll(async () => {
    const handle = await createPgliteDb();
    db = handle.db;
  });

  it('create_record inserts and returns the row with a prefixed id', async () => {
    const ctx = makeActionContext({ db });
    const res = (await handleCreateRecord(
      { entity: 'workflow', data: { name: 'created via action' } },
      ctx,
    )) as { created: boolean; record: { id: string; name: string } };

    expect(res.created).toBe(true);
    expect(res.record.id).toMatch(/^wfl_/);

    const [row] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, res.record.id));
    expect(row?.name).toBe('created via action');
  });

  it('create_record throws when entity type is missing', async () => {
    await expect(handleCreateRecord({ data: { name: 'x' } }, makeActionContext({ db }))).rejects.toThrow(
      /entity/i,
    );
  });

  it('query_data excludes soft-deleted rows and applies an eq filter', async () => {
    const ctx = makeActionContext({ db });
    const marker = 'qd-marker';
    // one live row via the action, one pre-soft-deleted row inserted directly
    await handleCreateRecord({ entity: 'workflow', data: { name: marker } }, ctx);
    await db.insert(schema.workflows).values({
      id: 'wfl_softdeleted_fixture',
      name: marker,
      deletedAt: new Date(),
    });

    const res = (await handleQueryData({ entity: 'workflow', filters: { name: marker } }, ctx)) as {
      records: Array<{ name: string }>;
      count: number;
    };

    expect(res.count).toBe(1);
    expect(res.records.every((r) => r.name === marker)).toBe(true);
  });

  it('update_record changes fields and throws when the row is missing', async () => {
    const ctx = makeActionContext({ db });
    const created = (await handleCreateRecord(
      { entity: 'workflow', data: { name: 'before' } },
      ctx,
    )) as { record: { id: string } };

    const res = (await handleUpdateRecord(
      { entity: 'workflow', id: created.record.id, data: { name: 'after' } },
      ctx,
    )) as { updated: boolean };
    expect(res.updated).toBe(true);

    const [row] = await db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, created.record.id));
    expect(row?.name).toBe('after');

    await expect(
      handleUpdateRecord({ entity: 'workflow', id: 'wfl_does_not_exist', data: {} }, ctx),
    ).rejects.toThrow(/not found/i);
  });

  it('delete_record soft-deletes by default and hard-deletes when asked', async () => {
    const ctx = makeActionContext({ db });
    const a = (await handleCreateRecord({ entity: 'workflow', data: { name: 'soft' } }, ctx)) as {
      record: { id: string };
    };
    await handleDeleteRecord({ entity: 'workflow', id: a.record.id }, ctx);
    const [softRow] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, a.record.id));
    expect(softRow?.deletedAt).not.toBeNull();

    const b = (await handleCreateRecord({ entity: 'workflow', data: { name: 'hard' } }, ctx)) as {
      record: { id: string };
    };
    await handleDeleteRecord({ entity: 'workflow', id: b.record.id, hardDelete: true }, ctx);
    const rows = await db.select().from(schema.workflows).where(eq(schema.workflows.id, b.record.id));
    expect(rows).toHaveLength(0);
  });
});
