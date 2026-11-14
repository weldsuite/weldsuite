/**
 * Which usage email, if any, a settlement owes the workspace's owners
 * (weldsuite-documentation/plans/weldpanel.md: 80% and 100% of the allowance, and when data is
 * being dropped), once per threshold per month.
 *
 * What was sent lives on the month's `panel_usage_monthly.notified`. The marker
 * is claimed with a compare-and-set before the mail goes out, so two
 * settlements racing for the same threshold send one mail; a send that then
 * fails is lost rather than retried into a flood (the banner in the module
 * still shows the state).
 */

import { and, eq, sql } from 'drizzle-orm';
import type { PanelUsageEmailKind } from '@weldsuite/emails';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import type { PanelPlanLimits } from '@weldsuite/panel-domain/plans';
import type { PanelQuotaState } from '@weldsuite/panel-domain/registry';
import type { PanelUsageMonth, WorkspacePlan } from './usage-settlement';

const { panelUsageMonthly } = masterSchema;

/** In rising severity. `80` and `100` are percent of an allowance. */
export const NOTICE_MARKERS = ['80', '100', 'replay_blocked', 'events_blocked'] as const;
export type NoticeMarker = (typeof NOTICE_MARKERS)[number];

const KIND: Record<NoticeMarker, PanelUsageEmailKind> = {
  '80': 'near',
  '100': 'full',
  replay_blocked: 'replay_blocked',
  events_blocked: 'events_blocked',
};

export interface UsageNotice {
  workspaceId: string;
  workspaceName: string;
  clerkOrgId: string | null;
  kind: PanelUsageEmailKind;
  month: string;
  events: { used: number; allowance: number };
  recordings: { used: number; allowance: number };
}

function percentOf(used: number, allowance: number): number {
  if (allowance > 0) return (used * 100) / allowance;
  return used > 0 ? Number.POSITIVE_INFINITY : 0;
}

/** Every marker the month's usage and quota state have reached. Pure. */
export function reachedMarkers(
  limits: Pick<PanelPlanLimits, 'events' | 'recordings'>,
  usage: Pick<PanelUsageMonth, 'events' | 'recordings'>,
  quota: PanelQuotaState,
): NoticeMarker[] {
  const top = Math.max(percentOf(usage.events, limits.events), percentOf(usage.recordings, limits.recordings));
  const reached: NoticeMarker[] = [];
  if (top >= 80) reached.push('80');
  if (top >= 100) reached.push('100');
  if (quota === 'replay_blocked' || quota === 'events_blocked') reached.push('replay_blocked');
  if (quota === 'events_blocked') reached.push('events_blocked');
  return reached;
}

/**
 * The notice to send now, or null. Claims every marker reached (so a lower one
 * skipped because a higher one is due never follows) and returns the mail for
 * the highest marker that was not sent before.
 */
export async function planUsageNotice(
  masterDb: AnyMasterDatabase,
  workspace: WorkspacePlan,
  usage: PanelUsageMonth,
  quota: PanelQuotaState,
): Promise<UsageNotice | null> {
  const reached = reachedMarkers(workspace.limits, usage, quota);
  let notified = usage.notified ?? [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const unsent = reached.filter((marker) => !notified.includes(marker));
    if (unsent.length === 0) return null;
    const next = [...new Set([...notified, ...reached])];
    const claimed = await masterDb
      .update(panelUsageMonthly)
      .set({ notified: next, updatedAt: new Date() })
      .where(and(eq(panelUsageMonthly.id, usage.id), sql`${panelUsageMonthly.notified} = ${JSON.stringify(notified)}::jsonb`))
      .returning({ id: panelUsageMonthly.id });
    if (claimed.length === 0) {
      // Another settlement moved the markers first: look again.
      const [fresh] = await masterDb.select({ notified: panelUsageMonthly.notified }).from(panelUsageMonthly).where(eq(panelUsageMonthly.id, usage.id)).limit(1);
      notified = fresh?.notified ?? [];
      continue;
    }
    const highest = unsent.reduce((a, b) => (NOTICE_MARKERS.indexOf(b) > NOTICE_MARKERS.indexOf(a) ? b : a), unsent[0]!);
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      clerkOrgId: workspace.clerkOrgId,
      kind: KIND[highest],
      month: usage.month,
      events: { used: usage.events, allowance: workspace.limits.events },
      recordings: { used: usage.recordings, allowance: workspace.limits.recordings },
    };
  }
  return null;
}
