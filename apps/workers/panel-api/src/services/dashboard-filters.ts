/**
 * A dashboard's filters on its report tiles: the one place that decides what
 * a tile runs. The authenticated dashboard (`GET /dashboards/:id` hands each
 * report tile its spec) and the public share route (`POST
 * /public/panel/share/:token/results`) both call {@link tileSpec}, so a shared
 * dashboard shows exactly what its members see.
 */

import {
  applyPanelDashboardFilters,
  panelDashboardFiltersSchema,
  type PanelDashboardFilters,
} from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import {
  panelQuerySpecSchema,
  type PanelDateRange,
  type ParsedPanelQuerySpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';

/** Stored filters as the query schema reads them; null for none or for a shape that no longer parses. */
export function parseDashboardFilters(raw: unknown): PanelDashboardFilters | null {
  if (!raw) return null;
  const parsed = panelDashboardFiltersSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.dateRange || parsed.data.filters.length > 0 ? parsed.data : null;
}

/**
 * The spec a report tile runs: the report's spec with the dashboard's date
 * range and filters applied, then `dateRange` (a share link viewer's preset)
 * on top. Null when the result does not parse (the report's and the
 * dashboard's filters together go over the limit).
 */
export function tileSpec(
  reportSpec: Record<string, unknown>,
  filters: PanelDashboardFilters | null,
  dateRange?: PanelDateRange,
): ParsedPanelQuerySpec | null {
  const merged = applyPanelDashboardFilters(reportSpec, filters);
  const parsed = panelQuerySpecSchema.safeParse(dateRange ? { ...merged, dateRange } : merged);
  return parsed.success ? parsed.data : null;
}
