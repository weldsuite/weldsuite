import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { SheetDataDefinition } from '@weldsuite/app-api-client/schemas/sheet-data';
import { createSheet } from '../sheets';
import {
  dataSourceEventData,
  deleteDataSource,
  dueDataSources,
  getDataSource,
  insertDataSource,
  listDataSources,
  nextDueAt,
  nextRefreshAfter,
  recordRefresh,
  toDataSource,
  updateDataSource,
} from './sources';

const { sheetDataSources, sheets, files } = schema;
const HOUR = 60 * 60 * 1000;
const definition: SheetDataDefinition = { columns: ['name'], headers: ['Name'], filters: [], limit: 100 };

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(sheetDataSources);
  await db.delete(sheets);
  await db.delete(files);
  for (const id of ['sht_1', 'sht_2']) await createSheet(db, { workspaceId: 'org_1', sheetId: id, name: id, folderId: null, userId: 'alice', snapshotSize: 1 });
});

const source = (id: string, refresh: 'manual' | 'hourly' | 'daily', sheetId = 'sht_1') =>
  insertDataSource(db, { id, sheetId, objectType: 'companies', definition, refresh, createdById: 'alice' });

describe('nextRefreshAfter', () => {
  it('schedules hourly and daily refreshes, and never a manual one', () => {
    const from = new Date(Date.UTC(2026, 0, 1));
    expect(nextRefreshAfter('hourly', from)).toEqual(new Date(from.getTime() + HOUR));
    expect(nextRefreshAfter('daily', from)).toEqual(new Date(from.getTime() + 24 * HOUR));
    expect(nextRefreshAfter('manual', from)).toBeNull();
  });
});

describe('connected tables', () => {
  it('saves one, shows it to the API and in events, and finds it on its own sheet only', async () => {
    const row = await source('ds_1', 'hourly');
    expect(row.nextRefreshAt!.getTime() - row.createdAt.getTime()).toBe(HOUR);
    expect(toDataSource(row)).toMatchObject({
      id: 'ds_1',
      sheetId: 'sht_1',
      objectType: 'companies',
      definition,
      refresh: 'hourly',
      lastRefreshedAt: null,
      nextRefreshAt: row.nextRefreshAt!.toISOString(),
      lastError: null,
      createdById: 'alice',
      createdAt: row.createdAt.toISOString(),
    });
    expect(dataSourceEventData(row)).toEqual({ id: 'ds_1', sheetId: 'sht_1', objectType: 'companies', refresh: 'hourly', createdById: 'alice' });
    expect((await getDataSource(db, 'sht_1', 'ds_1'))?.id).toBe('ds_1');
    expect(await getDataSource(db, 'sht_2', 'ds_1')).toBeNull();
  });

  it('lists a sheet’s tables, and which scheduled ones are due', async () => {
    const hourly = await source('ds_hourly', 'hourly');
    await source('ds_manual', 'manual');
    const daily = await source('ds_daily', 'daily');
    await source('ds_elsewhere', 'hourly', 'sht_2');
    expect((await listDataSources(db, 'sht_1')).map((r) => r.id).sort()).toEqual(['ds_daily', 'ds_hourly', 'ds_manual']);
    expect(await nextDueAt(db, 'sht_1')).toEqual(hourly.nextRefreshAt);
    expect(await dueDataSources(db, 'sht_1', new Date())).toEqual([]);
    const later = new Date(daily.nextRefreshAt!.getTime() + 1);
    expect((await dueDataSources(db, 'sht_1', later)).map((r) => r.id)).toEqual(['ds_hourly', 'ds_daily']);
    expect(await nextDueAt(db, 'sht_missing')).toBeNull();
  });

  it('changes one, rescheduling it when its refresh changes', async () => {
    await source('ds_1', 'manual');
    const scheduled = await updateDataSource(db, 'sht_1', 'ds_1', { refresh: 'daily' });
    expect(scheduled).toMatchObject({ refresh: 'daily', nextRefreshAt: expect.any(Date) });
    const handedOver = await updateDataSource(db, 'sht_1', 'ds_1', { createdById: 'bob' });
    expect(handedOver).toMatchObject({ createdById: 'bob', nextRefreshAt: scheduled!.nextRefreshAt });
    expect(await updateDataSource(db, 'sht_2', 'ds_1', { refresh: 'manual' })).toBeNull();
  });

  it('records how a refresh went', async () => {
    const row = await source('ds_1', 'hourly');
    const at = new Date(Date.UTC(2026, 0, 2));
    const ok = await recordRefresh(db, row, { at, rowCount: 12 });
    expect(ok).toMatchObject({ lastRefreshedAt: at, rowCount: 12, lastError: null, nextRefreshAt: new Date(at.getTime() + HOUR) });
    const failed = await recordRefresh(db, row, { at: new Date(at.getTime() + HOUR), error: 'no_access' });
    expect(failed).toMatchObject({ lastRefreshedAt: at, rowCount: 12, lastError: 'no_access' });
    expect(await recordRefresh(db, { ...row, id: 'ds_missing' }, { at })).toBeNull();
    expect((await recordRefresh(db, row, { at }))?.rowCount).toBe(0);
  });

  it('deletes one from its own sheet only', async () => {
    await source('ds_1', 'manual');
    expect(await deleteDataSource(db, 'sht_2', 'ds_1')).toBeNull();
    expect((await deleteDataSource(db, 'sht_1', 'ds_1'))?.id).toBe('ds_1');
    expect(await listDataSources(db, 'sht_1')).toEqual([]);
  });
});
