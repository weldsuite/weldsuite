/**
 * What WeldAgent tools do with spreadsheets, server-side:
 * /internal/agent/:workspaceId/sheets/*, reached only through the
 * `SheetsInternal` entrypoint (a service binding), so trusted by topology.
 *
 *   POST /find             → sheets the person can open, by name
 *   POST /create           → a new sheet, optionally with values in its first tab
 *   POST /:id/tabs         → its tabs and the cells each uses
 *   POST /:id/read         → values and formulas of a range
 *   POST /:id/write        → values written from a range's top-left cell
 *
 * Every call acts for the person the agent works for (`x-weld-user`): it sees
 * and changes only what their WeldDrive access (and project membership) allows.
 * The tool registry checks the agent's own `sheets:*` grants before calling.
 * Writes go through the sheet's room, so everyone in the sheet sees them at once.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Engine, Sheet, Workbook, applyOp, valuesOp } from '@weldsuite/sheets-engine';
import { and, eq, isNull } from 'drizzle-orm';
import { getWorkspaceContextForOrg, schema } from '@weldsuite/worker-kit/db';
import { createDrizzlePermissionQueries, hasContextPermission, resolveEffectivePermissions } from '@weldsuite/permissions/server';
import { error, success } from '@weldsuite/worker-kit/response';
import { workspaceMovingResponse, workspaceReadOnlyBody } from '@weldsuite/worker-kit';
import { fileRole, loadDriveAccessForUser, visibleFilesCondition } from '@weldsuite/core-domain/drive-access';
import type { Env, Variables } from '../../types';
import { listSheets } from '../../services/sheets';
import { newTabId } from '../../room/people';
import { findSheet, mayEditSheet, roomFor, roomMeta } from '../sheets/access';
import { saveNewSheet } from '../sheets';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * The same refusal `licenceGate` answers a write with, ahead of the public
 * routes' handlers: a database move is retryable (503), any other read-only
 * reason is not (403). Null when the workspace may be written to.
 */
function readOnlyRefusal(c: Ctx): Response | null {
  if (!c.get('readOnly')) return null;
  const reason = c.get('readOnlyReason');
  if (reason === 'database_move') return workspaceMovingResponse(c);
  return c.json(workspaceReadOnlyBody(reason), 403);
}

/** Cells one write takes at most. */
const MAX_WRITE_CELLS = 50_000;
const cellInput = z.union([z.string().max(32_767), z.number(), z.boolean(), z.null()]);
const values = z
  .array(z.array(cellInput).max(16_384))
  .max(1_048_576)
  .refine((rows) => rows.reduce((n, r) => n + r.length, 0) <= MAX_WRITE_CELLS, `At most ${MAX_WRITE_CELLS} cells per write`);
const rangeRequest = z.object({ tab: z.string().max(200).optional(), range: z.string().max(200).optional() });

app.use('/:workspaceId/*', async (c, next) => {
  const userId = c.req.header('x-weld-user');
  if (!userId) return error.unauthorized(c);
  const workspaceId = c.req.param('workspaceId');
  c.set('workspaceId', workspaceId);
  c.set('userId', userId);
  // Same as workspaceDbMiddleware (the public routes' path here): the tenant
  // DB plus the workspace's read-only state, so a lapsed workspace cannot be
  // written to through the agent either.
  const { db, readOnly, readOnlyReason } = await getWorkspaceContextForOrg(c.env, workspaceId);
  c.set('tenantDb', db);
  c.set('readOnly', readOnly);
  c.set('readOnlyReason', readOnlyReason);
  c.set('internalTrusted', true);
  // Their permissions as they are now, for the same checks the public routes make.
  c.set('userPermissions', await resolveEffectivePermissions(createDrizzlePermissionQueries(db, schema, { eq, and, isNull }), userId));
  await next();
});

app.post('/:workspaceId/sheets/find', zValidator('json', z.object({ query: z.string().max(255).optional(), limit: z.number().int().min(1).max(50).optional() })), async (c) => {
  if (!(await hasContextPermission(c, 'sheets:read'))) return error.forbidden(c);
  const db = c.get('tenantDb');
  const { query, limit = 20 } = c.req.valid('json');
  const access = await loadDriveAccessForUser(db, c.get('userId') ?? null);
  const { rows } = await listSheets(db, { visible: visibleFilesCondition(access), search: query, limit, offset: 0 });
  return success(
    c,
    rows.map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt.toISOString(), role: fileRole(access, s.file) ?? 'viewer' })),
  );
});

app.post('/:workspaceId/sheets/create', zValidator('json', z.object({ name: z.string().trim().min(1).max(255), values: values.optional(), tabName: z.string().trim().min(1).max(100).optional() })), async (c) => {
  if (!(await hasContextPermission(c, 'sheets:create'))) return error.forbidden(c);
  const refused = readOnlyRefusal(c);
  if (refused) return refused;
  const workspaceId = c.get('workspaceId')!;
  const userId = c.get('userId')!;
  const input = c.req.valid('json');
  const workbook = new Workbook();
  const tab = new Sheet(newTabId(), input.tabName ?? 'Sheet1');
  workbook.sheets.push(tab);
  const engine = new Engine(workbook);
  // The first checkpoint holds the values, calculated like any edit.
  if (input.values?.length) applyOp(engine, valuesOp(tab.id, { row: 0, col: 0 }, input.values));
  const sheet = await saveNewSheet(c, { workspaceId, userId, name: input.name, folderId: null, workbook: engine.toSnapshot() });
  return success(c, { id: sheet.id, name: sheet.name, tabId: tab.id, url: `/weldsheets/${sheet.id}` }, 201);
});

app.post('/:workspaceId/sheets/:id/tabs', async (c) => {
  if (!(await hasContextPermission(c, 'sheets:read'))) return error.forbidden(c);
  const found = await findSheet(c, c.req.param('id'));
  if (found instanceof Response) return found;
  const tabs = await roomFor(c, c.get('workspaceId')!, found.sheet).tabs(roomMeta(found.sheet, c.get('workspaceId')!));
  return success(c, { id: found.sheet.id, name: found.sheet.name, tabs });
});

app.post('/:workspaceId/sheets/:id/read', zValidator('json', rangeRequest), async (c) => {
  if (!(await hasContextPermission(c, 'sheets:read'))) return error.forbidden(c);
  const found = await findSheet(c, c.req.param('id'));
  if (found instanceof Response) return found;
  const result = await roomFor(c, c.get('workspaceId')!, found.sheet).readRange(roomMeta(found.sheet, c.get('workspaceId')!), c.req.valid('json'));
  return result.ok ? success(c, result) : error.badRequest(c, result.error);
});

app.post('/:workspaceId/sheets/:id/write', zValidator('json', rangeRequest.extend({ values })), async (c) => {
  const found = await findSheet(c, c.req.param('id'));
  if (found instanceof Response) return found;
  const refused = readOnlyRefusal(c);
  if (refused) return refused;
  if (!(await mayEditSheet(c, found.role))) return error.forbidden(c, 'You can view this spreadsheet but not change it');
  const workspaceId = c.get('workspaceId')!;
  const result = await roomFor(c, workspaceId, found.sheet).writeRange(roomMeta(found.sheet, workspaceId), {
    ...c.req.valid('json'),
    userId: c.get('userId')!,
  });
  return result.ok ? success(c, result) : error.badRequest(c, result.error);
});

export default app;
