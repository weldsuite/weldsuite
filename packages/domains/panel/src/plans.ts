/**
 * What each plan includes of WeldPanel: the monthly allowance of events and
 * recordings and how long they are kept (ADR PANEL-007, weldsuite-documentation/plans/weldpanel.md
 * "Plan allowance and overage"). Keyed by the plan's slug in the master
 * `plans` table; an unknown slug (or no plan) gets the Free numbers.
 *
 * `@weldsuite/credits` has a per-plan meter mechanism (`plans.features`, see
 * its `meters.ts`), but its meters count one unit per call through a Durable
 * Object in front of the work, and WeldPanel settles counts the collector
 * already took. So the numbers live here, and a plan can still override the two
 * allowances through `plans.features.panelEventsPerMonth` /
 * `panelRecordingsPerMonth` (whole numbers, no schema change: `PlanFeatures`
 * takes any key).
 */

import type { ReplayTier } from './replays';

/** Overage is charged and counted in blocks of this many events / recordings. */
export const PANEL_EVENT_BLOCK = 10_000;
export const PANEL_RECORDING_BLOCK = 100;
/** Events keep being accepted this far over the allowance when the wallet cannot pay a block (counted from the allowance). */
export const PANEL_EVENT_GRACE = 0.1;
/** A favourited recording is kept this long, whatever the plan. */
export const PANEL_FAVORITE_RETENTION_MONTHS = 13;

export interface PanelPlanLimits {
  /** Events included per UTC month. */
  events: number;
  /** Recordings (sessions) included per UTC month. */
  recordings: number;
  /** Months events are kept. */
  eventRetentionMonths: number;
  /** Days recordings are kept: the `30d` or `90d` lifecycle tier. */
  recordingRetentionDays: 30 | 90;
  /** The tier new recording chunks are written to. */
  replayTier: Extract<ReplayTier, '30d' | '90d'>;
}

const FREE: PanelPlanLimits = {
  events: 50_000,
  recordings: 500,
  eventRetentionMonths: 12,
  recordingRetentionDays: 30,
  replayTier: '30d',
};

const LIMITS: Record<string, PanelPlanLimits> = {
  free: FREE,
  business: { events: 1_000_000, recordings: 5_000, eventRetentionMonths: 25, recordingRetentionDays: 30, replayTier: '30d' },
  scale: { events: 5_000_000, recordings: 25_000, eventRetentionMonths: 25, recordingRetentionDays: 90, replayTier: '90d' },
  enterprise: { events: 20_000_000, recordings: 100_000, eventRetentionMonths: 25, recordingRetentionDays: 90, replayTier: '90d' },
};

function override(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** The limits of the plan with this slug, with the two allowances optionally overridden by the plan's `features`. */
export function panelPlanLimits(planSlug: string | null | undefined, features?: Record<string, unknown> | null): PanelPlanLimits {
  const base = LIMITS[(planSlug ?? '').trim().toLowerCase()] ?? FREE;
  if (!features) return { ...base };
  return {
    ...base,
    events: override(features.panelEventsPerMonth, base.events),
    recordings: override(features.panelRecordingsPerMonth, base.recordings),
  };
}

/** Whole overage blocks that `used` needs beyond `allowance`: 0 inside the allowance, 1 for the first unit past it. */
export function overageBlocks(used: number, allowance: number, blockSize: number): number {
  return Math.ceil(Math.max(0, used - allowance) / blockSize);
}

/** Events accepted before they are dropped when blocks cannot be paid: the allowance plus 10%. */
export function eventGraceLimit(allowance: number): number {
  return Math.floor(allowance * (1 + PANEL_EVENT_GRACE));
}
