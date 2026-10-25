/**
 * Version history: /api/sheets/:id/versions/*.
 *
 *   GET    /                        → saved versions, newest first (read access)
 *   POST   /                        → save the sheet as it is now under a name (edit access)
 *   PATCH  /:versionId              → rename a version (edit access)
 *   GET    /:versionId/snapshot     → the workbook as the version saved it (read access)
 *   GET    /:versionId/export       → the version as an .xlsx (read access)
 *   POST   /:versionId/restore      → make the version the sheet again (edit access)
 *
 * The sheet's room holds the live workbook, so it writes the snapshots: a
 * version is the room's state when it was saved, edits not checkpointed yet
 * included. A restore first saves the sheet as it was as an automatic version
 * (no name), and every client in the room reloads (see SheetRoom). Edit
 * access is the drive role (owner or editor) plus `sheets:update`. The same
 * routes as WeldDocs' version history.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Engine } from '@weldsuite/sheets-engine';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  createSheetVersionSchema,
  listSheetVersionsQuerySchema,
  sheetFileLocaleSchema,
  updateSheetVersionSchema,
  type SheetRestoreResult,
} from '@weldsuite/app-api-client/schemas/sheets';
import type { Env, Variables } from '../../types';
import { getSheet } from '../../services/sheets';
import { getVersion, insertVersion, listVersions, renameVersion, toVersion, versionEventData, versionKeyFor } from '../../services/versions';
import { readSnapshot } from '../../room/snapshot';
import { exportEngine } from '../../room/sheet-room';
import { attachment, XLSX_TYPE } from './download';
import { editableSheet, eventData, findSheet, roomFor, roomMeta } from './access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_LIMIT = 50;

app.get('/', requirePermission('sheets:read'), zValidator('query', listSheetVersionsQuerySchema), async (c) => {
  const found = await findSheet(c, c.req.param('id') ?? '');
  if (found instanceof Response) return found;
  const { limit = DEFAULT_LIMIT, cursor } = c.req.valid('query');
  const { rows, total, hasMore } = await listVersions(c.get('tenantDb'), found.sheet.id, { limit, after: cursor });
  const last = rows.at(-1);
  return list(c, rows.map(toVersion), cursorPagination(total, hasMore, hasMore && last ? last.id : null));
});

app.post('/', requirePermission('sheets:update'), zValidator('json', createSheetVersionSchema), async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  if (!userId) return error.unauthorized(c);
  if (!workspaceId) return error.orgRequired(c);
  const sheet = await editableSheet(c);
  if (sheet instanceof Response) return sheet;

  const meta = roomMeta(sheet, workspaceId);
  const id = generateId('shtv');
  const snapshotKey = versionKeyFor(meta.snapshotKey, id);
  const saved = await roomFor(c, workspaceId, sheet).saveVersion(meta, snapshotKey);
  const row = await insertVersion(c.get('tenantDb'), {
    id,
    sheetId: sheet.id,
    revision: saved.revision,
    name: c.req.valid('json').name,
    snapshotKey,
    size: saved.size,
    createdById: userId,
  });
  publishEntityEvent({ c, entityType: 'sheet_version', entityId: row.id, action: 'created', data: versionEventData(row) });
  return success(c, toVersion(row), 201);
});

app.patch('/:versionId', requirePermission('sheets:update'), zValidator('json', updateSheetVersionSchema), async (c) => {
  const sheet = await editableSheet(c);
  if (sheet instanceof Response) return sheet;
  const versionId = c.req.param('versionId');
  const db = c.get('tenantDb');
  const previous = await getVersion(db, sheet.id, versionId);
  if (!previous) return error.notFound(c, 'Version', versionId);
  const row = await renameVersion(db, sheet.id, versionId, c.req.valid('json').name);
  if (!row) return error.notFound(c, 'Version', versionId);
  publishEntityEvent({
    c,
    entityType: 'sheet_version',
    entityId: row.id,
    action: 'updated',
    data: versionEventData(row),
    changes: { name: { old: previous.name, new: row.name } },
  });
  return success(c, toVersion(row));
});

/** A version's stored workbook, if the caller may see the sheet; else the response to send. */
async function storedVersion(c: Parameters<typeof findSheet>[0]) {
  const found = await findSheet(c, c.req.param('id') ?? '');
  if (found instanceof Response) return found;
  const versionId = c.req.param('versionId') ?? '';
  const version = await getVersion(c.get('tenantDb'), found.sheet.id, versionId);
  const stored = version ? await readSnapshot(c.env.PRIVATE_STORAGE, version.snapshotKey) : null;
  if (!version || !stored) return error.notFound(c, 'Version', versionId);
  return { sheet: found.sheet, version, stored };
}

app.get('/:versionId/snapshot', requirePermission('sheets:read'), async (c) => {
  const found = await storedVersion(c);
  if (found instanceof Response) return found;
  c.header('Cache-Control', 'private, no-store');
  return success(c, { revision: found.stored.revision, snapshot: found.stored.workbook });
});

app.get('/:versionId/export', requirePermission('sheets:read'), async (c) => {
  const found = await storedVersion(c);
  if (found instanceof Response) return found;
  const locale = sheetFileLocaleSchema.safeParse(c.req.query('locale')).data;
  const engine = Engine.fromSnapshot(found.stored.workbook);
  engine.recalcAll();
  const file = await exportEngine(engine, { format: 'xlsx', locale });
  const label = found.version.name ?? found.version.createdAt.toISOString().slice(0, 16).replace('T', ' ');
  return new Response(file!.bytes, {
    headers: {
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': attachment(`${found.sheet.name} (${label.replaceAll(':', '.')}).xlsx`),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

app.post('/:versionId/restore', requirePermission('sheets:update'), async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  if (!userId) return error.unauthorized(c);
  if (!workspaceId) return error.orgRequired(c);
  const sheet = await editableSheet(c);
  if (sheet instanceof Response) return sheet;
  const versionId = c.req.param('versionId');
  const db = c.get('tenantDb');
  const version = await getVersion(db, sheet.id, versionId);
  if (!version) return error.notFound(c, 'Version', versionId);

  const autoVersionId = generateId('shtv');
  const outcome = await roomFor(c, workspaceId, sheet).restoreVersion({
    sheet: roomMeta(sheet, workspaceId),
    versionId,
    versionKey: version.snapshotKey,
    autoVersionId,
    userId,
  });
  if (!outcome.ok) return error.notFound(c, 'Version', versionId);
  const autoVersion = await getVersion(db, sheet.id, autoVersionId);
  if (!autoVersion) throw new Error(`The automatic version ${autoVersionId} is missing after a restore`);

  const updated = (await getSheet(db, sheet.id)) ?? sheet;
  publishEntityEvent({ c, entityType: 'sheet_version', entityId: autoVersion.id, action: 'created', data: versionEventData(autoVersion) });
  publishEntityEvent({
    c,
    entityType: 'sheet',
    entityId: sheet.id,
    action: 'updated',
    data: { ...eventData(updated), revision: outcome.revision, updatedById: userId },
    changes: { revision: { old: autoVersion.revision, new: outcome.revision } },
  });
  return success(c, { revision: outcome.revision, autoVersion: toVersion(autoVersion) } satisfies SheetRestoreResult);
});

export default app;
