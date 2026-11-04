import type { BaselineComparison } from '@weldsuite/app-api-client/domains/flow-approvals';

export interface OverlayRow {
  id: string;
  kind: 'go_live' | 'milestone' | 'deliverable';
  label: string;
  /** Agreed dates (the baseline); null when the item did not exist then. */
  baselineStart: string | null;
  baselineEnd: string | null;
  /** The dates now. */
  currentStart: string | null;
  currentEnd: string | null;
  /** Days the end moved against the baseline; null when unknown. */
  deltaDays: number | null;
  change: 'unchanged' | 'moved' | 'added' | 'removed';
  /** A pending change request would move the end to this date (drawn dashed). */
  pendingEnd: string | null;
  pendingCode: string | null;
}

/** The rows of the baseline overlay: go-live, milestones and deliverables, with their pending previews. */
export function overlayRows(comparison: BaselineComparison, goLiveLabel: string): OverlayRow[] {
  const { diff, pending } = comparison;
  const rows: OverlayRow[] = [];
  if (diff.goLive.from || diff.goLive.to) {
    const goLivePending = pending.find((p) => p.goLive);
    rows.push({
      id: 'go-live',
      kind: 'go_live',
      label: goLiveLabel,
      baselineStart: diff.goLive.from,
      baselineEnd: diff.goLive.from,
      currentStart: diff.goLive.to,
      currentEnd: diff.goLive.to,
      deltaDays: diff.goLive.deltaDays,
      change: diff.goLive.deltaDays ? 'moved' : 'unchanged',
      pendingEnd: goLivePending?.goLive ?? null,
      pendingCode: goLivePending?.code ?? null,
    });
  }
  for (const milestone of diff.milestones) {
    const preview = pending.flatMap((p) => p.milestones.filter((m) => m.milestoneId === milestone.id).map((m) => ({ to: m.to, code: p.code })))[0];
    rows.push({
      id: milestone.id,
      kind: 'milestone',
      label: milestone.name,
      baselineStart: milestone.from,
      baselineEnd: milestone.from,
      currentStart: milestone.to,
      currentEnd: milestone.to,
      deltaDays: milestone.deltaDays,
      change: milestone.change,
      pendingEnd: preview?.to ?? null,
      pendingCode: preview?.code ?? null,
    });
  }
  for (const deliverable of diff.deliverables) {
    const preview = pending.flatMap((p) => p.deliverables.filter((d) => d.deliverableId === deliverable.id && d.plannedEnd).map((d) => ({ to: d.plannedEnd as string, code: p.code })))[0];
    rows.push({
      id: deliverable.id,
      kind: 'deliverable',
      label: `D${deliverable.number} ${deliverable.title}`,
      baselineStart: deliverable.start.from,
      baselineEnd: deliverable.end.from,
      currentStart: deliverable.start.to,
      currentEnd: deliverable.end.to,
      deltaDays: deliverable.end.deltaDays,
      change: deliverable.change,
      pendingEnd: preview?.to ?? null,
      pendingCode: preview?.code ?? null,
    });
  }
  return rows;
}

/** The time range the rows span, in epoch milliseconds, with a day of margin; null without dates. */
export function overlayAxis(rows: readonly OverlayRow[]): { min: number; max: number } | null {
  const times: number[] = [];
  for (const row of rows) {
    for (const value of [row.baselineStart, row.baselineEnd, row.currentStart, row.currentEnd, row.pendingEnd]) {
      if (value) times.push(new Date(value).getTime());
    }
  }
  if (times.length === 0) return null;
  const day = 86_400_000;
  return { min: Math.min(...times) - day, max: Math.max(...times) + day };
}

/** Left and width, in percent of the axis, of a bar from `start` to `end` (a point when one is missing or they are equal). */
export function barBox(axis: { min: number; max: number }, start: string | null, end: string | null): { left: number; width: number } | null {
  const a = start ?? end;
  const b = end ?? start;
  if (!a || !b) return null;
  const span = axis.max - axis.min || 1;
  const from = Math.min(new Date(a).getTime(), new Date(b).getTime());
  const to = Math.max(new Date(a).getTime(), new Date(b).getTime());
  return { left: ((from - axis.min) / span) * 100, width: Math.max(((to - from) / span) * 100, 0.8) };
}

/** Items that ended later than agreed. */
export function slippedItems(rows: readonly OverlayRow[]): number {
  return rows.filter((row) => row.kind !== 'go_live' && (row.deltaDays ?? 0) > 0).length;
}
