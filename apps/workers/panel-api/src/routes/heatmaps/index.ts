/**
 * Heatmaps: /api/panel/heatmaps/*. The heat data is the `heatmap` kind of
 * `POST /api/panel/query`; this router holds the saved page groups and the
 * snapshot the heat is drawn on.
 *
 *   GET    /pages                    → page groups (?projectId)           (`panel_reports:read`)
 *   POST   /pages                    → new page group                      (`panel_reports:create`)
 *   PATCH  /pages/:id                → name, URL pattern                   (`panel_reports:update`)
 *   DELETE /pages/:id                → delete, with its stored snapshots   (`panel_reports:delete`)
 *   GET    /pages/:id/snapshot       → the masked full snapshot, gzip      (`panel_recordings:read`)
 *
 * Page groups are the workspace's, like cohorts. The snapshot is what a visitor
 * saw, so it takes the recordings permission rather than the reports one. 404
 * with `SNAPSHOT_REQUESTED` when none exists yet and a request was left for the
 * next consented visitor (try again later), `SNAPSHOT_UNAVAILABLE` when this
 * environment stores no recordings.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createPanelHeatmapPageSchema,
  panelSnapshotQuerySchema,
  updatePanelHeatmapPageSchema,
} from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelHeatmapPage } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import {
  createHeatmapPage,
  deleteHeatmapPage,
  dropSnapshots,
  getHeatmapPage,
  heatmapPageEventData,
  listHeatmapPages,
  resolveSnapshot,
  toHeatmapPageDto,
  updateHeatmapPage,
} from '../../services/heatmaps';
import { projectExists } from '../../services/saved-objects';
import { queryRunDeps } from '../../services/query-run';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({ projectId: z.string().min(1).max(30) });

function publish(c: Ctx, page: PanelHeatmapPage, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_heatmap_page', entityId: page.id, action, data: heatmapPageEventData(page) });
}

app.get('/pages', requirePermission('panel_reports:read'), zValidator('query', listQuery), async (c) => {
  const pages = await listHeatmapPages(c.get('tenantDb'), c.req.valid('query').projectId);
  return list(c, pages.map(toHeatmapPageDto), cursorPagination(pages.length, false, null));
});

app.post('/pages', requirePermission('panel_reports:create'), zValidator('json', createPanelHeatmapPageSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  if (!(await projectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  const page = await createHeatmapPage(db, input, userId);
  publish(c, page, 'created');
  return success(c, toHeatmapPageDto(page), 201);
});

app.patch('/pages/:id', requirePermission('panel_reports:update'), zValidator('json', updatePanelHeatmapPageSchema), async (c) => {
  const id = c.req.param('id');
  const page = await updateHeatmapPage(c.get('tenantDb'), id, c.req.valid('json'));
  if (!page) return error.notFound(c, 'Heatmap page', id);
  publish(c, page, 'updated');
  return success(c, toHeatmapPageDto(page));
});

app.delete('/pages/:id', requirePermission('panel_reports:delete'), async (c) => {
  const id = c.req.param('id');
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const page = await deleteHeatmapPage(c.get('tenantDb'), id);
  if (!page) return error.notFound(c, 'Heatmap page', id);
  try {
    await dropSnapshots(c.env, workspaceId, page);
  } catch (err) {
    // The page group is gone; a leftover snapshot object is unreachable (its id is no longer a page group) and ages out with the bucket.
    console.error('[panel-api] could not delete the snapshots of a removed heatmap page', err);
  }
  publish(c, page, 'deleted');
  return noContent(c);
});

app.get('/pages/:id/snapshot', requirePermission('panel_recordings:read'), zValidator('query', panelSnapshotQuerySchema), async (c) => {
  const id = c.req.param('id');
  const { deviceClass } = c.req.valid('query');
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const tenantDb = c.get('tenantDb');
  const page = await getHeatmapPage(tenantDb, id);
  if (!page) return error.notFound(c, 'Heatmap page', id);

  const result = await resolveSnapshot(queryRunDeps(c.env, tenantDb, workspaceId), page, deviceClass);
  if (result.status === 'found') {
    return c.body(result.body, 200, {
      'Content-Type': 'application/gzip',
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'X-Snapshot-Source': result.source,
    });
  }
  if (result.status === 'requested') {
    return c.json(
      { error: { code: 'SNAPSHOT_REQUESTED', message: 'No recording covers this page yet. A snapshot was requested from the next visitor; try again later.' } },
      404,
    );
  }
  return c.json({ error: { code: 'SNAPSHOT_UNAVAILABLE', message: 'Snapshots are not stored in this environment' } }, 404);
});

export default app;
