/**
 * Grid views — /api/grid-views/:gridName. Per-user (or workspace-shared)
 * data-grid column visibility + widths, backed by tenant `grid_views`.
 *
 * Ported from apps/api-worker /settings/grid-views/:gridName (W3
 * legacy-worker phase-out).
 *
 * Permissions: personal self-scoped resource — reads AND writes use the
 * baseline general:read (see routes/notifications for the pattern). Rows are
 * always scoped to the authenticated user, except for grids in
 * WORKSPACE_SHARED_GRIDS which use a sentinel user id so one row holds the
 * workspace-wide configuration (legacy behaviour: any member may write those
 * — preserved).
 *
 * Entity events: none — `grid_view` is not in the packages/core/entity-events
 * catalog.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const { gridViews } = schema;

// Grid names whose column visibility/widths are shared across the whole
// workspace instead of being stored per user. Reads/writes for these grids
// use a sentinel user id so a single row in `grid_views` represents the
// workspace-wide configuration (the existing (user_id, grid_name) unique
// index still applies because the sentinel is constant).
const WORKSPACE_SHARED_GRIDS = new Set(['customer']);
const WORKSPACE_GRID_USER_ID = '__workspace__';

function resolveGridUserId(gridName: string, userId: string): string {
  return WORKSPACE_SHARED_GRIDS.has(gridName) ? WORKSPACE_GRID_USER_ID : userId;
}

const gridViewSchema = z.object({
  columnVisibility: z.record(z.boolean()),
  columnWidths: z.record(z.number()),
});

/**
 * GET /:gridName — grid view settings for a specific grid (null when unset).
 */
app.get('/:gridName', requirePermission('general:read'), async (c) => {
  const userId = c.get('userId');
  const gridName = c.req.param('gridName');
  const effectiveUserId = resolveGridUserId(gridName, userId);

  try {
    const db = c.get('tenantDb');

    const [view] = await db
      .select()
      .from(gridViews)
      .where(and(eq(gridViews.userId, effectiveUserId), eq(gridViews.gridName, gridName)))
      .limit(1);

    if (!view) {
      return success(c, null);
    }

    return success(c, {
      columnVisibility: view.columnVisibility || {},
      columnWidths: view.columnWidths || {},
    });
  } catch (err) {
    console.error('[app-api/grid-views] Failed to fetch grid view:', err);
    return error.internal(c, 'Failed to fetch grid view');
  }
});

/**
 * PUT /:gridName — upsert grid view settings.
 */
app.put(
  '/:gridName',
  requirePermission('general:read'),
  zValidator('json', gridViewSchema),
  async (c) => {
    const userId = c.get('userId');
    const gridName = c.req.param('gridName');
    const data = c.req.valid('json');
    const effectiveUserId = resolveGridUserId(gridName, userId);

    try {
      const db = c.get('tenantDb');

      const [existing] = await db
        .select()
        .from(gridViews)
        .where(and(eq(gridViews.userId, effectiveUserId), eq(gridViews.gridName, gridName)))
        .limit(1);

      if (existing) {
        await db
          .update(gridViews)
          .set({
            columnVisibility: data.columnVisibility,
            columnWidths: data.columnWidths,
            updatedAt: new Date(),
          })
          .where(eq(gridViews.id, existing.id));
      } else {
        await db.insert(gridViews).values({
          id: generateId('gv'),
          userId: effectiveUserId,
          gridName,
          columnVisibility: data.columnVisibility,
          columnWidths: data.columnWidths,
        });
      }

      return success(c, {
        columnVisibility: data.columnVisibility,
        columnWidths: data.columnWidths,
      });
    } catch (err) {
      console.error('[app-api/grid-views] Failed to update grid view:', err);
      return error.internal(c, 'Failed to update grid view');
    }
  },
);

export const gridViewsRoutes = app;
