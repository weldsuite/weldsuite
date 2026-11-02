import { z } from 'zod';

// ============================================================================
// Grid views — a member's (or, for the shared grids, the workspace's) column
// visibility and widths for one data grid. Backed by `grid_views`;
// `/api/grid-views/:gridName` answers `null` for a grid never configured.
// ============================================================================

export const gridViewSettingsSchema = z.object({
  columnVisibility: z.record(z.boolean()),
  columnWidths: z.record(z.number()),
});

/** `GET` and `PUT /api/grid-views/:gridName`. */
export const gridViewResponseSchema = gridViewSettingsSchema.nullable();

export type GridViewSettings = z.infer<typeof gridViewSettingsSchema>;
