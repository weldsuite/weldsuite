/**
 * What a query runs against: the authenticated scope (never from the spec),
 * the plan's retention and what the PanelProject object knows about the project.
 */

import type { ParsedPanelCohortFilter } from '@weldsuite/app-api-client/schemas/weldpanel-query';

export const BASIN_NAMESPACE = 'panel';

/** Most a query may look back: 25 months. */
export const MAX_RETENTION_DAYS = 762;

export interface PanelQueryContext {
  /** `workspaces.id` of the authenticated workspace. */
  workspaceId: string;
  /** The project the caller may read; must equal the spec's `projectId`. */
  projectId: string;
  /** The plan's event retention in days, at most {@link MAX_RETENTION_DAYS}. */
  retentionDays: number;
  /** `PanelProject.hasIdentifiedUsers()`: the identity join is added only then. */
  hasIdentifiedUsers: boolean;
  /** `PanelProject.erasedIds()`: excluded from every query until the Iceberg rows are rewritten. */
  erasedIds: readonly string[];
  /** Saved cohorts by id, for `cohort` filters (the caller loads the ones the spec names). */
  cohorts?: Record<string, ParsedPanelCohortFilter>;
  /** Saved heatmap page groups: id → URL pattern. */
  pageGroups?: Record<string, string>;
  /** Favourited session ids (tenant DB), for `favoritesOnly`. */
  favoriteSessionIds?: readonly string[];
  /** Injected clock for tests. */
  now?: Date;
}
