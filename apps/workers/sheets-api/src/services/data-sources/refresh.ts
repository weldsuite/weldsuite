/**
 * What a connected table shows now: its records listed with the access of the
 * person who connected it, as the block the sheet's room writes.
 *
 * A refresh lists only what that person may still read (the object's
 * permission, not denied) and only while they may still edit the sheet, so a
 * scheduled refresh never shows more than they could see themselves, and
 * stops when they lose access. Failures are codes the editor shows in its own
 * words (`SheetDataRefreshError`).
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { hasPermission } from '@weldsuite/permissions';
import { createDrizzlePermissionQueries, resolveEffectivePermissions } from '@weldsuite/permissions/server';
import { canEdit, fileRole, loadDriveAccessForUser, type DriveFileRef } from '@weldsuite/core-domain/drive-access';
import {
  SHEET_DATA_OBJECTS,
  checkSheetDataDefinition,
  type SheetDataFieldType,
  type SheetDataObjectKey,
} from '@weldsuite/app-api-client/schemas/sheet-data';
import type { SheetDataRefreshError } from '@weldsuite/app-api-client/schemas/sheets';
import type { DataTableWrite } from '@weldsuite/sheets-engine';
import { SheetDataPermissionError, listRecords } from './query';
import type { DataSourceRecord } from './sources';

/** How each kind of field shows in the sheet. */
const FORMATS: Partial<Record<SheetDataFieldType, string>> = {
  date: 'yyyy-mm-dd',
  datetime: 'yyyy-mm-dd hh:mm',
  currency: '#,##0.00',
};

export type RefreshResult = { ok: true; write: Omit<DataTableWrite, 'at'>; rowCount: number } | { ok: false; error: SheetDataRefreshError };

/** May `userId` list this object, and still change this sheet? */
export async function refreshAccess(
  db: Database,
  userId: string,
  objectType: string,
  file: DriveFileRef,
): Promise<SheetDataRefreshError | null> {
  const object = SHEET_DATA_OBJECTS[objectType as SheetDataObjectKey];
  if (!object) return 'invalid';
  const allowed = await permissionsOf(db, userId);
  if (!allowed(object.permission)) return 'no_permission';
  const role = fileRole(await loadDriveAccessForUser(db, userId), file);
  if (!role || !canEdit(role) || !allowed('sheets:update')) return 'no_access';
  return null;
}

/** Whether `userId` holds a permission now (member denies win). */
async function permissionsOf(db: Database, userId: string): Promise<(key: string) => boolean> {
  const resolved = await resolveEffectivePermissions(createDrizzlePermissionQueries(db, schema, { eq, and, isNull }), userId);
  const denies = resolved.denies ?? [];
  return (key) => hasPermission(resolved.permissions, key) && !hasPermission(denies, key);
}

/** The block a refresh of `source` writes, or why it cannot be refreshed now. */
export async function buildRefresh(db: Database, source: DataSourceRecord, file: DriveFileRef): Promise<RefreshResult> {
  const objectType = source.objectType as SheetDataObjectKey;
  if (!SHEET_DATA_OBJECTS[objectType] || checkSheetDataDefinition(objectType, source.definition) !== null) return { ok: false, error: 'invalid' };
  const denied = await refreshAccess(db, source.createdById, objectType, file);
  if (denied) return { ok: false, error: denied };
  let rows;
  try {
    // Listed as the person who connected it: their records, their scope.
    const viewer = { userId: source.createdById, hasPermission: await permissionsOf(db, source.createdById) };
    rows = await listRecords(db, objectType, source.definition, viewer);
  } catch (err) {
    if (err instanceof SheetDataPermissionError) return { ok: false, error: 'no_permission' };
    console.error('[sheets-api/data-sources] listing records failed:', err);
    return { ok: false, error: 'failed' };
  }
  const fields = new Map(SHEET_DATA_OBJECTS[objectType].fields.map((f) => [f.key, f]));
  const formats = source.definition.columns.map((key) => FORMATS[fields.get(key)?.type ?? 'text']);
  return { ok: true, write: { id: source.id, header: source.definition.headers, rows, formats }, rowCount: rows.length };
}
