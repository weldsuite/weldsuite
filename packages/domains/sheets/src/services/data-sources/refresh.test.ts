import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { SheetDataDefinition } from '@weldsuite/app-api-client/schemas/sheet-data';
import type { DriveFileRef } from '@weldsuite/core-domain/drive-access';
import { SheetDataPermissionError } from './errors';
import { buildRefresh, refreshAccess } from './refresh';
import type { DataSourceRecord } from './sources';

let db: Database;

/** Set to make the next listings fail. */
const listing = vi.hoisted(() => ({ fail: null as Error | null }));
vi.mock('./query', async (importOriginal) => {
  const real = await importOriginal<typeof import('./query')>();
  return { ...real, listRecords: (...args: Parameters<typeof real.listRecords>) => (listing.fail ? Promise.reject(listing.fail) : real.listRecords(...args)) };
});

/** The sheet's drive file: alice made it, nobody else is given access. */
const file: DriveFileRef = { id: 'fil_sheet', uploadedById: 'alice', folderId: null, generalAccess: 'restricted', entityType: null };
const definition: SheetDataDefinition = { columns: ['name', 'createdAt'], headers: ['Name', 'Created'], filters: [], limit: 100 };

const source = (values: Partial<DataSourceRecord> = {}) =>
  ({ id: 'ds_1', sheetId: 'sht_1', objectType: 'companies', definition, refresh: 'manual', createdById: 'alice', ...values }) as DataSourceRecord;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_alice', userId: 'alice', name: 'Alice', role: 'OWNER' },
    { id: 'wm_bob', userId: 'bob', name: 'Bob', role: 'MEMBER' },
  ]);
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.companies);
  await db.insert(schema.companies).values([
    { id: 'cmp_1', name: 'Acme', displayName: 'Acme', createdAt: new Date(Date.UTC(2026, 0, 1)) },
    { id: 'cmp_2', name: 'Bolt', displayName: 'Bolt', createdAt: new Date(Date.UTC(2026, 0, 2)) },
  ]);
});

afterEach(() => {
  listing.fail = null;
  vi.restoreAllMocks();
});

describe('refreshAccess', () => {
  it('lets the person who connected the table refresh it while they may still edit the sheet', async () => {
    expect(await refreshAccess(db, 'alice', 'companies', file)).toBeNull();
  });

  it('refuses an unknown object, someone without the object’s permission, and someone who cannot edit the sheet', async () => {
    expect(await refreshAccess(db, 'alice', 'spaceships', file)).toBe('invalid');
    expect(await refreshAccess(db, 'stranger', 'companies', file)).toBe('no_permission');
    expect(await refreshAccess(db, 'bob', 'companies', file)).toBe('no_access');
  });
});

describe('buildRefresh', () => {
  it('lists the records as the block the room writes, dates formatted as dates', async () => {
    const result = await buildRefresh(db, source(), file);
    expect(result).toMatchObject({ ok: true, rowCount: 2, write: { id: 'ds_1', header: ['Name', 'Created'], formats: [undefined, 'yyyy-mm-dd hh:mm'] } });
    if (!result.ok) throw new Error(result.error);
    expect(result.write.rows.map((r) => r[0])).toEqual(['Bolt', 'Acme']);
  });

  it('refuses a table whose definition is no longer valid, or whose owner lost access', async () => {
    expect(await buildRefresh(db, source({ objectType: 'spaceships' }), file)).toEqual({ ok: false, error: 'invalid' });
    expect(await buildRefresh(db, source({ definition: { ...definition, columns: ['nope'], headers: ['Nope'] } }), file)).toEqual({ ok: false, error: 'invalid' });
    expect(await buildRefresh(db, source({ createdById: 'bob' }), file)).toEqual({ ok: false, error: 'no_access' });
  });

  it('reports a listing the person may no longer make, or that failed', async () => {
    listing.fail = new SheetDataPermissionError('companies:read');
    expect(await buildRefresh(db, source(), file)).toEqual({ ok: false, error: 'no_permission' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    listing.fail = new Error('the database is down');
    expect(await buildRefresh(db, source(), file)).toEqual({ ok: false, error: 'failed' });
    expect(errors).toHaveBeenCalledWith('[sheets-api/data-sources] listing records failed:', listing.fail);
  });
});
