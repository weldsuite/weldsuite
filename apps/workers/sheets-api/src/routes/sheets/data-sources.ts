/**
 * Connected tables: /api/sheets/:id/data-sources/*.
 *
 *   GET    /                    → the sheet's connected tables (read access)
 *   POST   /                    → connect one, written at `target` by its first refresh (edit access)
 *   PATCH  /:sourceId           → change what it lists or when it refreshes; refreshes it (edit access)
 *   POST   /:sourceId/refresh   → refresh it now (edit access)
 *   DELETE /:sourceId           → disconnect it; its values stay in the sheet (edit access)
 *
 * A table lists records with the access of the person who connected it (or
 * last changed what it lists): connecting and changing one needs the object's
 * own read permission, so nobody can widen what another person's access lists.
 * The records go into the sheet through its room, as an edit everyone sees;
 * scheduled refreshes run on the room's alarm.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission, hasContextPermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { SHEET_DATA_OBJECTS, checkSheetDataDefinition } from '@weldsuite/app-api-client/schemas/sheet-data';
import {
  createSheetDataSourceSchema,
  updateSheetDataSourceSchema,
  type SheetDataRefreshResult,
} from '@weldsuite/app-api-client/schemas/sheets';
import type { DataTablePlace } from '@weldsuite/sheets-engine';
import type { Env, Variables } from '../../types';
import { newTabId } from '../../room/people';
import type { SheetRecord } from '../../services/sheets';
import { buildRefresh } from '../../services/data-sources/refresh';
import {
  dataSourceEventData,
  deleteDataSource,
  getDataSource,
  insertDataSource,
  listDataSources,
  nextDueAt,
  recordRefresh,
  toDataSource,
  updateDataSource,
  type DataSourceRecord,
} from '../../services/data-sources/sources';
import { editableSheet, findSheet, roomFor, roomMeta, type Ctx } from './access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('sheets:read'), async (c) => {
  const found = await findSheet(c, c.req.param('id') ?? '');
  if (found instanceof Response) return found;
  const rows = await listDataSources(c.get('tenantDb'), found.sheet.id);
  return list(c, rows.map(toDataSource), { totalCount: rows.length, hasMore: false, cursor: null });
});

app.post('/', requirePermission('sheets:update'), zValidator('json', createSheetDataSourceSchema), async (c) => {
  const userId = c.get('userId');
  const clerkOrgId = c.get('clerkOrgId');
  if (!userId) return error.unauthorized(c);
  if (!clerkOrgId) return error.orgRequired(c);
  const sheet = await editableSheet(c);
  if (sheet instanceof Response) return sheet;
  const input = c.req.valid('json');
  if (!(await hasContextPermission(c, SHEET_DATA_OBJECTS[input.objectType].permission))) {
    return error.forbidden(c, 'You cannot read this kind of record');
  }

  const db = c.get('tenantDb');
  const row = await insertDataSource(db, {
    id: generateId('shds'),
    sheetId: sheet.id,
    objectType: input.objectType,
    definition: input.definition,
    refresh: input.refresh,
    createdById: userId,
  });
  publishEntityEvent({ c, entityType: 'sheet_data_source', entityId: row.id, action: 'created', data: dataSourceEventData(row) });
  const { target } = input;
  const at: DataTablePlace =
    'newTab' in target ? { newSheet: { id: newTabId(), name: target.newTab } } : { sheetId: target.tabId, row: target.row, col: target.col };
  const result = await refreshNow(c, { sheet, clerkOrgId, userId, source: row, at });
  await reschedule(c, sheet, clerkOrgId);
  return success(c, result, 201);
});

app.patch('/:sourceId', requirePermission('sheets:update'), zValidator('json', updateSheetDataSourceSchema), async (c) => {
  const userId = c.get('userId');
  const clerkOrgId = c.get('clerkOrgId');
  if (!userId) return error.unauthorized(c);
  if (!clerkOrgId) return error.orgRequired(c);
  const sheet = await editableSheet(c);
  if (sheet instanceof Response) return sheet;
  const db = c.get('tenantDb');
  const sourceId = c.req.param('sourceId');
  const previous = await getDataSource(db, sheet.id, sourceId);
  if (!previous) return error.notFound(c, 'Data source', sourceId);
  const { definition, refresh } = c.req.valid('json');
  if (definition) {
    const problem = checkSheetDataDefinition(previous.objectType as keyof typeof SHEET_DATA_OBJECTS, definition);
    if (problem) return error.badRequest(c, problem);
    // Whoever decides what it lists lists it with their own access.
    const permission = SHEET_DATA_OBJECTS[previous.objectType as keyof typeof SHEET_DATA_OBJECTS]?.permission;
    if (!permission || !(await hasContextPermission(c, permission))) return error.forbidden(c, 'You cannot read this kind of record');
  }
  const row = await updateDataSource(db, sheet.id, sourceId, {
    ...(definition ? { definition, createdById: userId } : {}),
    ...(refresh ? { refresh } : {}),
  });
  if (!row) return error.notFound(c, 'Data source', sourceId);
  publishEntityEvent({ c, entityType: 'sheet_data_source', entityId: row.id, action: 'updated', data: dataSourceEventData(row) });
  const result = await refreshNow(c, { sheet, clerkOrgId, userId, source: row });
  await reschedule(c, sheet, clerkOrgId);
  return success(c, result);
});

app.post('/:sourceId/refresh', requirePermission('sheets:update'), async (c) => {
  const userId = c.get('userId');
  const clerkOrgId = c.get('clerkOrgId');
  if (!userId) return error.unauthorized(c);
  if (!clerkOrgId) return error.orgRequired(c);
  const sheet = await editableSheet(c);
  if (sheet instanceof Response) return sheet;
  const sourceId = c.req.param('sourceId');
  const source = await getDataSource(c.get('tenantDb'), sheet.id, sourceId);
  if (!source) return error.notFound(c, 'Data source', sourceId);
  const result = await refreshNow(c, { sheet, clerkOrgId, userId, source });
  await reschedule(c, sheet, clerkOrgId);
  return success(c, result);
});

app.delete('/:sourceId', requirePermission('sheets:update'), async (c) => {
  const userId = c.get('userId');
  const clerkOrgId = c.get('clerkOrgId');
  if (!userId) return error.unauthorized(c);
  if (!clerkOrgId) return error.orgRequired(c);
  const sheet = await editableSheet(c);
  if (sheet instanceof Response) return sheet;
  const sourceId = c.req.param('sourceId');
  const row = await deleteDataSource(c.get('tenantDb'), sheet.id, sourceId);
  if (!row) return error.notFound(c, 'Data source', sourceId);
  await roomFor(c, clerkOrgId, sheet).dropDataTable(roomMeta(sheet, clerkOrgId), row.id, userId);
  await reschedule(c, sheet, clerkOrgId);
  publishEntityEvent({ c, entityType: 'sheet_data_source', entityId: row.id, action: 'deleted', data: dataSourceEventData(row) });
  return noContent(c);
});

/**
 * Lists the records and has the room write them, recording how it went. A
 * table that is not in the workbook yet goes at `at`.
 */
async function refreshNow(
  c: Ctx,
  params: { sheet: SheetRecord; clerkOrgId: string; userId: string; source: DataSourceRecord; at?: DataTablePlace },
): Promise<SheetDataRefreshResult> {
  const db = c.get('tenantDb');
  const { sheet, clerkOrgId, userId, source } = params;
  const plan = await buildRefresh(db, source, sheet.file);
  let failure = plan.ok ? null : plan.error;
  if (plan.ok) {
    const written = await roomFor(c, clerkOrgId, sheet).writeDataTable(roomMeta(sheet, clerkOrgId), { ...plan.write, at: params.at }, userId);
    if (!written.ok) failure = 'unplaced';
  }
  const row = (await recordRefresh(db, source, { at: new Date(), rowCount: plan.ok ? plan.rowCount : 0, error: failure })) ?? source;
  publishEntityEvent({ c, entityType: 'sheet_data_source', entityId: row.id, action: 'updated', data: dataSourceEventData(row) });
  return { source: toDataSource(row), refreshed: failure === null };
}

/** Tells the room when the sheet's next scheduled refresh is due. */
async function reschedule(c: Ctx, sheet: SheetRecord, clerkOrgId: string): Promise<void> {
  const next = await nextDueAt(c.get('tenantDb'), sheet.id);
  await roomFor(c, clerkOrgId, sheet).scheduleRefresh(roomMeta(sheet, clerkOrgId), next ? next.getTime() : null);
}

export default app;
