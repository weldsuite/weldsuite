/**
 * Raw exports: /api/panel/exports/*. A project's events, people, groups and
 * identity links written to the customer's S3-compatible bucket as gzipped
 * JSON Lines, hourly or daily (the runner: services/exports.ts, run by the
 * cron in ./scheduled.ts). Everything here is `panel_projects:manage`.
 *
 *   GET    /                → the project's exports (?projectId)
 *   POST   /                → new export (backfills from `startAt`)
 *   POST   /test            → write and delete `_weldpanel_test.txt` at a destination
 *   GET    /:id             → one export
 *   PATCH  /:id             → name, destination, secret key, tables, frequency
 *   DELETE /:id             → soft delete; nothing more is written
 *   GET    /:id/runs        → one row per table and window (?cursor, ?limit)
 *   POST   /:id/pause       → stop writing
 *   POST   /:id/resume      → carry on from where it stopped
 *
 * The secret access key is write-only (sealed, never returned). Mutations
 * publish `panel_export` entity events with the provider, bucket and status,
 * never the credentials.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { checkSafeUrl } from '@weldsuite/worker-kit/safe-url';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createPanelExportSchema,
  testPanelExportSchema,
  updatePanelExportSchema,
} from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import type { PanelExport } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { projectExists } from '../../services/saved-objects';
import {
  createExport,
  deleteExport,
  exportEventData,
  getExport,
  listExportRuns,
  listExports,
  nextRunOf,
  setExportStatus,
  testDestination,
  toExportDto,
  toExportRunDto,
  updateExport,
} from '../../services/exports';
import { deleteSchedule, nextRunsOf, upsertSchedule } from '../../services/schedule';
import { SecretsUnavailableError, openSecret, sealSecret } from '../../services/secrets';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const MANAGE = 'panel_projects:manage';

const listQuery = z.object({ projectId: z.string().min(1).max(30) });
const pageQuery = z.object({
  cursor: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

function publish(c: Ctx, exp: PanelExport, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_export', entityId: exp.id, action, data: exportEventData(exp) });
}

async function dto(c: Ctx, exp: PanelExport) {
  const next = await nextRunsOf(getMasterDb(c.env), 'export', [exp.id]);
  return toExportDto(exp, next.get(exp.id) ?? null);
}

async function schedule(c: Ctx, exp: PanelExport, nextRunAt: Date | null): Promise<void> {
  await upsertSchedule(getMasterDb(c.env), { workspaceId: c.get('workspaceId'), kind: 'export', objectId: exp.id, nextRunAt });
}

/** A store's endpoint must be a public https:// host (no private or internal address). */
function unsafeEndpoint(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  const check = checkSafeUrl(endpoint);
  return check.ok ? null : `The endpoint is not allowed: ${check.reason}`;
}

app.get('/', requirePermission(MANAGE), zValidator('query', listQuery), async (c) => {
  const exports = await listExports(c.get('tenantDb'), c.req.valid('query').projectId);
  const next = await nextRunsOf(getMasterDb(c.env), 'export', exports.map((e) => e.id));
  return list(c, exports.map((e) => toExportDto(e, next.get(e.id) ?? null)), cursorPagination(exports.length, false, null));
});

app.post('/', requirePermission(MANAGE), zValidator('json', createPanelExportSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  if (!(await projectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);
  const unsafe = unsafeEndpoint(input.destination.endpoint);
  if (unsafe) return error.badRequest(c, unsafe);
  const now = new Date();
  const startAt = input.startAt ? new Date(Math.min(new Date(input.startAt).getTime(), now.getTime())) : now;

  let secret: string;
  try {
    secret = await sealSecret(c.env, input.secretAccessKey);
  } catch (err) {
    if (err instanceof SecretsUnavailableError) return error.unavailable(c, err.message);
    throw err;
  }
  const exp = await createExport(db, input, secret, userId, startAt);
  // Due at once: the first run (and any backfill) starts with the next cron.
  await schedule(c, exp, now);
  publish(c, exp, 'created');
  return success(c, await dto(c, exp), 201);
});

app.post('/test', requirePermission(MANAGE), zValidator('json', testPanelExportSchema), async (c) => {
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  let saved: PanelExport | null = null;
  if (input.exportId) {
    saved = await getExport(db, input.exportId);
    if (!saved) return error.notFound(c, 'Export', input.exportId);
  } else if (input.projectId && !(await projectExists(db, input.projectId))) {
    return error.notFound(c, 'Project', input.projectId);
  }
  const destination = input.destination ?? (saved ? { ...saved.destination } : null);
  if (!destination) return error.badRequest(c, 'Send a destination');
  const unsafe = unsafeEndpoint(destination.endpoint);
  if (unsafe) return error.badRequest(c, unsafe);

  let secretAccessKey = input.secretAccessKey ?? null;
  try {
    if (!secretAccessKey && saved) secretAccessKey = await openSecret(c.env, saved.secretCiphertext);
  } catch (err) {
    if (err instanceof SecretsUnavailableError) return error.unavailable(c, err.message);
    throw err;
  }
  if (!secretAccessKey) return error.badRequest(c, 'Send the secret access key');
  return success(c, await testDestination(destination, { accessKeyId: destination.accessKeyId, secretAccessKey }));
});

app.get('/:id', requirePermission(MANAGE), async (c) => {
  const id = c.req.param('id');
  const exp = await getExport(c.get('tenantDb'), id);
  if (!exp) return error.notFound(c, 'Export', id);
  return success(c, await dto(c, exp));
});

app.patch('/:id', requirePermission(MANAGE), zValidator('json', updatePanelExportSchema), async (c) => {
  const id = c.req.param('id');
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  const existing = await getExport(db, id);
  if (!existing) return error.notFound(c, 'Export', id);
  const unsafe = unsafeEndpoint(input.destination?.endpoint);
  if (unsafe) return error.badRequest(c, unsafe);

  let secret: string | null = null;
  try {
    if (input.secretAccessKey) secret = await sealSecret(c.env, input.secretAccessKey);
  } catch (err) {
    if (err instanceof SecretsUnavailableError) return error.unavailable(c, err.message);
    throw err;
  }
  const exp = await updateExport(db, id, input, secret);
  if (!exp) return error.notFound(c, 'Export', id);
  // A new destination or key may fix what was failing: try again with the next cron.
  if (exp.status !== 'paused') await schedule(c, exp, input.destination || input.secretAccessKey ? new Date() : nextRunOf(exp, new Date()));
  publish(c, exp, 'updated');
  return success(c, await dto(c, exp));
});

app.delete('/:id', requirePermission(MANAGE), async (c) => {
  const id = c.req.param('id');
  const exp = await deleteExport(c.get('tenantDb'), id);
  if (!exp) return error.notFound(c, 'Export', id);
  await deleteSchedule(getMasterDb(c.env), { kind: 'export', objectId: id });
  publish(c, exp, 'deleted');
  return noContent(c);
});

app.get('/:id/runs', requirePermission(MANAGE), zValidator('query', pageQuery), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  if (!(await getExport(db, id))) return error.notFound(c, 'Export', id);
  const { cursor, limit = 50 } = c.req.valid('query');
  const rows = await listExportRuns(db, id, cursor ? new Date(cursor) : null, limit + 1);
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return list(c, page.map(toExportRunDto), cursorPagination(page.length, hasMore, hasMore ? page[page.length - 1]!.startedAt.toISOString() : null));
});

app.post('/:id/pause', requirePermission(MANAGE), async (c) => {
  const id = c.req.param('id');
  const exp = await setExportStatus(c.get('tenantDb'), id, 'paused');
  if (!exp) return error.notFound(c, 'Export', id);
  await deleteSchedule(getMasterDb(c.env), { kind: 'export', objectId: id });
  publish(c, exp, 'updated');
  return success(c, await dto(c, exp));
});

app.post('/:id/resume', requirePermission(MANAGE), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const existing = await getExport(db, id);
  if (!existing) return error.notFound(c, 'Export', id);
  const exp = existing.status === 'paused' ? await setExportStatus(db, id, 'active') : existing;
  if (!exp) return error.notFound(c, 'Export', id);
  await schedule(c, exp, new Date());
  publish(c, exp, 'updated');
  return success(c, await dto(c, exp));
});

export default app;
