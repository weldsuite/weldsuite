/**
 * Connected tables' records (`sheet_data_sources`): what each lists, whose
 * access lists it, and how its last refresh went. Pure functions over the
 * tenant DB; access checks happen in the routes and before each refresh.
 */

import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { SheetDataSource } from '@weldsuite/app-api-client/schemas/sheets';
import type { DataFor } from '@weldsuite/entity-events/events';

const { sheetDataSources } = schema;

export type DataSourceRecord = typeof sheetDataSources.$inferSelect;
export type DataRefresh = DataSourceRecord['refresh'];

const HOUR = 60 * 60 * 1000;

/** When a scheduled refresh is next due after `from`; null for manual ones. */
export function nextRefreshAfter(refresh: DataRefresh, from: Date): Date | null {
  if (refresh === 'hourly') return new Date(from.getTime() + HOUR);
  if (refresh === 'daily') return new Date(from.getTime() + 24 * HOUR);
  return null;
}

export function toDataSource(row: DataSourceRecord): SheetDataSource {
  return {
    id: row.id,
    sheetId: row.sheetId,
    objectType: row.objectType as SheetDataSource['objectType'],
    definition: row.definition,
    refresh: row.refresh,
    lastRefreshedAt: row.lastRefreshedAt?.toISOString() ?? null,
    nextRefreshAt: row.nextRefreshAt?.toISOString() ?? null,
    lastError: row.lastError as SheetDataSource['lastError'],
    rowCount: row.rowCount,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function dataSourceEventData(row: DataSourceRecord): DataFor<'sheet_data_source'> {
  return { id: row.id, sheetId: row.sheetId, objectType: row.objectType, refresh: row.refresh, createdById: row.createdById };
}

export async function insertDataSource(
  db: Database,
  params: Pick<DataSourceRecord, 'id' | 'sheetId' | 'objectType' | 'definition' | 'refresh' | 'createdById'>,
): Promise<DataSourceRecord> {
  const now = new Date();
  const [row] = await db
    .insert(sheetDataSources)
    .values({ ...params, createdAt: now, updatedAt: now, nextRefreshAt: nextRefreshAfter(params.refresh, now) })
    .returning();
  if (!row) throw new Error(`Data source ${params.id} was not inserted`);
  return row;
}

export async function getDataSource(db: Database, sheetId: string, id: string): Promise<DataSourceRecord | null> {
  const [row] = await db
    .select()
    .from(sheetDataSources)
    .where(and(eq(sheetDataSources.sheetId, sheetId), eq(sheetDataSources.id, id)))
    .limit(1);
  return row ?? null;
}

/** A sheet's connected tables, oldest first. */
export async function listDataSources(db: Database, sheetId: string): Promise<DataSourceRecord[]> {
  return db.select().from(sheetDataSources).where(eq(sheetDataSources.sheetId, sheetId)).orderBy(asc(sheetDataSources.createdAt));
}

/** A sheet's connected tables whose scheduled refresh is due at `now`. */
export async function dueDataSources(db: Database, sheetId: string, now: Date): Promise<DataSourceRecord[]> {
  return db
    .select()
    .from(sheetDataSources)
    .where(and(eq(sheetDataSources.sheetId, sheetId), isNotNull(sheetDataSources.nextRefreshAt), lte(sheetDataSources.nextRefreshAt, now)))
    .orderBy(asc(sheetDataSources.nextRefreshAt));
}

/** The earliest scheduled refresh of a sheet's connected tables, or null when none is scheduled. */
export async function nextDueAt(db: Database, sheetId: string): Promise<Date | null> {
  const rows = await db
    .select({ at: sheetDataSources.nextRefreshAt })
    .from(sheetDataSources)
    .where(and(eq(sheetDataSources.sheetId, sheetId), isNotNull(sheetDataSources.nextRefreshAt)))
    .orderBy(asc(sheetDataSources.nextRefreshAt))
    .limit(1);
  return rows[0]?.at ?? null;
}

export async function updateDataSource(
  db: Database,
  sheetId: string,
  id: string,
  patch: Partial<Pick<DataSourceRecord, 'definition' | 'refresh' | 'createdById'>>,
): Promise<DataSourceRecord | null> {
  const now = new Date();
  const set: Partial<DataSourceRecord> = { ...patch, updatedAt: now };
  if (patch.refresh) set.nextRefreshAt = nextRefreshAfter(patch.refresh, now);
  const [row] = await db
    .update(sheetDataSources)
    .set(set)
    .where(and(eq(sheetDataSources.sheetId, sheetId), eq(sheetDataSources.id, id)))
    .returning();
  return row ?? null;
}

/** Records how a refresh went, and when the next scheduled one is due. */
export async function recordRefresh(
  db: Database,
  row: DataSourceRecord,
  outcome: { at: Date; rowCount?: number; error?: string | null },
): Promise<DataSourceRecord | null> {
  const set: Partial<DataSourceRecord> = { nextRefreshAt: nextRefreshAfter(row.refresh, outcome.at), lastError: outcome.error ?? null };
  if (!outcome.error) {
    set.lastRefreshedAt = outcome.at;
    set.rowCount = outcome.rowCount ?? 0;
  }
  const [updated] = await db.update(sheetDataSources).set(set).where(eq(sheetDataSources.id, row.id)).returning();
  return updated ?? null;
}

export async function deleteDataSource(db: Database, sheetId: string, id: string): Promise<DataSourceRecord | null> {
  const [row] = await db
    .delete(sheetDataSources)
    .where(and(eq(sheetDataSources.sheetId, sheetId), eq(sheetDataSources.id, id)))
    .returning();
  return row ?? null;
}
