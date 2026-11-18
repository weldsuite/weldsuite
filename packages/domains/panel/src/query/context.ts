/**
 * What a query runs against: the authenticated scope (never from the spec),
 * the plan's retention and what the PanelProject object knows about the project.
 */

import type { PanelPathRule, ParsedPanelCohortFilter } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type {
  ParsedPanelComputedPropertyDefinition,
  ParsedPanelCustomEventDefinition,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';

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
  /** Custom events by id (`pnce_…`, without the `@`), for `@pnce_…` event refs (the caller loads the ones the spec names). */
  customEvents?: Record<string, ParsedPanelCustomEventDefinition>;
  /** Computed properties by id (`pncp_…`), for `@pncp_…` property refs. */
  computedProperties?: Record<string, ParsedPanelComputedPropertyDefinition>;
  /** The project's path rules in order (`panel_path_rules`), applied where reports group by path. */
  pathRules?: readonly PanelPathRule[];
  /** The project's group types (`panel_group_types.group_type`). When set, a spec naming another type is refused. */
  groupTypes?: readonly string[];
  /** Injected clock for tests. */
  now?: Date;
}
