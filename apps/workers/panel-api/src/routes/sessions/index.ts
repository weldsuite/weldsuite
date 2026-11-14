/**
 * Recordings: /api/panel/sessions/*. The list is the `sessions` kind of
 * `POST /api/panel/query`; this router serves one session.
 *
 *   GET    /:id                       → metadata, chunk manifest, timeline markers, person, favourite, cached summary
 *   GET    /:id/chunks/:seq           → one chunk's gzip bytes, streamed from the private bucket
 *   PUT    /:id/favorite              → favourite with a note; copies the chunks to `keep/`
 *   DELETE /:id/favorite              → unfavourite; deletes the copies
 *   GET    /:id/summary               → the cached AI summary, or `data: null` (never charges)
 *   POST   /:id/summary               → generate (and charge for) a summary unless one is cached
 *
 * All of it needs `panel_recordings:read` (a recording shows what a visitor saw
 * and did); the person on the detail also needs `panel_people:read`. Every
 * route takes `?projectId` (the body for PUT and POST) and answers 404 for a
 * project of another workspace. Sessions are tracked-visitor data: favourites
 * and summaries never go on the entity bus (EVT-005).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { resolveAiMetering } from '@weldsuite/core-domain/ai-billing';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { favoritePanelSessionSchema, generatePanelSessionSummarySchema } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { Env, Variables } from '../../types';
import { aiFailure, queryFailure, type PanelContext } from '../../http';
import { summariseSession } from '../../services/ai-summaries';
import { getProject } from '../../services/projects';
import { queryRunDeps } from '../../services/query-run';
import {
  SESSION_ID,
  chunkKeyFor,
  copyChunksToKeep,
  deleteKeepCopies,
  getFavorite,
  latestSessionSummary,
  loadChunks,
  loadSessionDetail,
  loadSessionRow,
  openChunk,
  removeFavorite,
  sessionContext,
  toFavoriteDto,
  toSessionSummaryDto,
  upsertFavorite,
} from '../../services/recordings';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const projectQuery = z.object({ projectId: z.string().min(1).max(30) });
const seqSchema = z.coerce.number().int().min(0).max(100_000);

/** The workspace and the session id, or the answer to give instead. */
function scoped(c: PanelContext): { workspaceId: string; sessionId: string } | Response {
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const sessionId = c.req.param('id') ?? '';
  if (!SESSION_ID.test(sessionId)) return error.badRequest(c, 'Invalid session id');
  return { workspaceId, sessionId };
}

app.get('/:id', requirePermission('panel_recordings:read'), zValidator('query', projectQuery), async (c) => {
  const { projectId } = c.req.valid('query');
  const scope = scoped(c);
  if (scope instanceof Response) return scope;
  const tenantDb = c.get('tenantDb');
  if (!(await getProject(tenantDb, projectId))) return error.notFound(c, 'Project', projectId);

  try {
    const detail = await loadSessionDetail(queryRunDeps(c.env, tenantDb, scope.workspaceId), projectId, scope.sessionId);
    if (!detail) return error.notFound(c, 'Session', scope.sessionId);
    // Profiles carry emails: without `panel_people:read` the player shows the visit, not the person.
    if (detail.person && !(await hasContextPermission(c, 'panel_people:read'))) detail.person = null;
    return success(c, detail);
  } catch (err) {
    return queryFailure(c, err);
  }
});

app.get('/:id/chunks/:seq', requirePermission('panel_recordings:read'), zValidator('query', projectQuery), async (c) => {
  const { projectId } = c.req.valid('query');
  const scope = scoped(c);
  if (scope instanceof Response) return scope;
  const seq = seqSchema.safeParse(c.req.param('seq'));
  if (!seq.success) return error.badRequest(c, 'Invalid chunk number');
  const tenantDb = c.get('tenantDb');
  if (!(await getProject(tenantDb, projectId))) return error.notFound(c, 'Project', projectId);
  if (!c.env.PANEL_REPLAYS) return error.notFound(c, 'Recording', scope.sessionId);

  try {
    const key = await chunkKeyFor(queryRunDeps(c.env, tenantDb, scope.workspaceId), projectId, scope.sessionId, seq.data);
    if (!key) return error.notFound(c, 'Chunk', `${scope.sessionId}/${seq.data}`);
    const object = await openChunk(c.env, tenantDb, projectId, scope.sessionId, key);
    if (!object) return error.notFound(c, 'Chunk', `${scope.sessionId}/${seq.data}`);
    // Raw gzip, deliberately without `Content-Encoding`: the player decompresses it itself.
    return c.body(object.body, 200, {
      'Content-Type': 'application/gzip',
      'Content-Length': String(object.size),
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      ETag: object.httpEtag,
    });
  } catch (err) {
    return queryFailure(c, err);
  }
});

app.put('/:id/favorite', requirePermission('panel_recordings:read'), zValidator('json', favoritePanelSessionSchema), async (c) => {
  const input = c.req.valid('json');
  const scope = scoped(c);
  if (scope instanceof Response) return scope;
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const tenantDb = c.get('tenantDb');
  if (!(await getProject(tenantDb, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  try {
    const deps = queryRunDeps(c.env, tenantDb, scope.workspaceId);
    const ctx = await sessionContext(deps, input.projectId);
    // Only a session that exists can be favourited, and the copies need its chunk keys.
    const known = (await getFavorite(tenantDb, input.projectId, scope.sessionId)) !== null;
    if (!(await loadSessionRow(c.env, ctx, scope.sessionId, known))) return error.notFound(c, 'Session', scope.sessionId);
    if (c.env.PANEL_REPLAYS) {
      const copied = await copyChunksToKeep(c.env.PANEL_REPLAYS, await loadChunks(c.env, ctx, scope.sessionId));
      if (copied === 0) console.warn(`[panel-api] favourite ${scope.sessionId}: no chunk was copied to keep/ (none stored, or already expired)`);
    }
    const row = await upsertFavorite(tenantDb, input.projectId, scope.sessionId, input.note ?? null, userId);
    return success(c, toFavoriteDto(row));
  } catch (err) {
    return queryFailure(c, err);
  }
});

app.delete('/:id/favorite', requirePermission('panel_recordings:read'), zValidator('query', projectQuery), async (c) => {
  const { projectId } = c.req.valid('query');
  const scope = scoped(c);
  if (scope instanceof Response) return scope;
  const tenantDb = c.get('tenantDb');
  if (!(await getProject(tenantDb, projectId))) return error.notFound(c, 'Project', projectId);
  if (!(await getFavorite(tenantDb, projectId, scope.sessionId))) return error.notFound(c, 'Favorite', scope.sessionId);

  try {
    // Copies first, the row last: when this fails the favourite is still there to repeat the request on.
    if (c.env.PANEL_REPLAYS) {
      const ctx = await sessionContext(queryRunDeps(c.env, tenantDb, scope.workspaceId), projectId);
      await deleteKeepCopies(c.env.PANEL_REPLAYS, await loadChunks(c.env, ctx, scope.sessionId));
    }
    await removeFavorite(tenantDb, projectId, scope.sessionId);
    return noContent(c);
  } catch (err) {
    return queryFailure(c, err);
  }
});

app.get('/:id/summary', requirePermission('panel_recordings:read'), zValidator('query', projectQuery), async (c) => {
  const { projectId } = c.req.valid('query');
  const scope = scoped(c);
  if (scope instanceof Response) return scope;
  const tenantDb = c.get('tenantDb');
  if (!(await getProject(tenantDb, projectId))) return error.notFound(c, 'Project', projectId);

  const row = await latestSessionSummary(tenantDb, projectId, scope.sessionId);
  return success(c, row ? toSessionSummaryDto(row) : null);
});

app.post('/:id/summary', requirePermission('panel_recordings:read'), zValidator('json', generatePanelSessionSummarySchema), async (c) => {
  const input = c.req.valid('json');
  const scope = scoped(c);
  if (scope instanceof Response) return scope;
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const tenantDb = c.get('tenantDb');
  const project = await getProject(tenantDb, input.projectId);
  if (!project) return error.notFound(c, 'Project', input.projectId);

  try {
    const deps = { ...queryRunDeps(c.env, tenantDb, scope.workspaceId), userId, metering: await resolveAiMetering(c.env, scope.workspaceId, userId) };
    const wide = (await getFavorite(tenantDb, project.id, scope.sessionId)) !== null;
    const summary = await summariseSession(deps, project, scope.sessionId, { regenerate: input.regenerate, wide });
    if (!summary) return error.notFound(c, 'Session', scope.sessionId);
    return success(c, summary);
  } catch (err) {
    return aiFailure(c, err);
  }
});

export default app;
