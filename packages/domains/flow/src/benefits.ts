/**
 * Benefit rules: numbering, progress toward the target, the goal-card targets,
 * and the shapes a benefit takes on the wire and in entity events (design:
 * weldflow-project-control.md; ADRs FLOW-011 and FLOW-014). The metric
 * catalogue is `./benefit-metrics`.
 *
 * Pure functions, no database and no Hono context. flow-api's
 * `/api/project-benefits` routes use them, and the Rust flow-domain mirrors
 * them. Every message returned here is sent to the client as it is, so the two
 * backends answer alike.
 */

import type { schema } from '@weldsuite/worker-kit/db';
import {
  BENEFIT_OPEN_STATUSES,
  goalTargetSchema,
  type Benefit,
  type BenefitMeasurement,
  type GoalTarget,
  type GoalTargetProgress,
} from '@weldsuite/app-api-client/schemas/project-governance';
import type { NumberSequence } from './task-numbering';

type BenefitRow = typeof schema.projectBenefits.$inferSelect;
type MeasurementRow = typeof schema.projectBenefitMeasurements.$inferSelect;

export const BENEFIT_MESSAGES = {
  futurePeriod: 'period cannot be in the future',
  goalTargetsProject: 'projectId is required',
} as const;

// ── Numbering ───────────────────────────────────────────────────────────────

/** The counter of a project's benefits: scope `ben:<projectId>`, prefix `B-`. */
export function benefitSequence(projectId: string): NumberSequence {
  return { scope: `ben:${projectId}`, prefix: 'B-' };
}

/** The display code of a benefit: `B-3`. */
export function benefitCode(number: number): string {
  return `B-${number}`;
}

// ── Status ──────────────────────────────────────────────────────────────────

/** Whether a benefit with this status is still measured. */
export function isOpenBenefitStatus(status: string): boolean {
  return (BENEFIT_OPEN_STATUSES as readonly string[]).includes(status);
}

/**
 * The `closed_at` a benefit gets when written with `status`: the time it first
 * reached realised or closed (kept while it stays there), null once it is open
 * again.
 */
export function benefitClosedAtFor(status: string, currentClosedAt: Date | null, now: Date): Date | null {
  if (isOpenBenefitStatus(status)) return null;
  return currentClosedAt ?? now;
}

// ── Progress ────────────────────────────────────────────────────────────────

/** A numeric column's text as a number, or null. */
function num(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * How far the current value has moved from the baseline toward the target, as a
 * whole percentage from 0 to 100 (past the target is 100, away from it 0).
 * Null when it cannot be told: a value is missing, or the target equals the
 * baseline and the current value is not on it.
 */
export function benefitProgress(
  baseline: string | null | undefined,
  target: string | null | undefined,
  current: string | null | undefined,
): number | null {
  const from = num(baseline);
  const to = num(target);
  const now = num(current);
  if (from === null || to === null || now === null) return null;
  if (to === from) return now === to ? 100 : null;
  const fraction = ((now - from) / (to - from)) * 100;
  return Math.round(Math.min(100, Math.max(0, fraction)));
}

/** Done tasks out of all, as a whole percentage; null when there are none. */
export function taskProgressPct(done: number, total: number): number | null {
  return total === 0 ? null : Math.round((done / total) * 100);
}

// ── Goal targets ────────────────────────────────────────────────────────────

/**
 * The targets of a goal card (`card.targets`), read leniently: the Goals page
 * stores cards as free JSON, so a target that does not parse is skipped, and
 * `index` stays the position in the card's list so the UI can match it.
 */
export function parseGoalTargets(card: unknown): Array<{ index: number; target: GoalTarget }> {
  if (!card || typeof card !== 'object') return [];
  const targets = (card as { targets?: unknown }).targets;
  if (!Array.isArray(targets)) return [];
  const out: Array<{ index: number; target: GoalTarget }> = [];
  targets.forEach((raw, index) => {
    const parsed = goalTargetSchema.safeParse(raw);
    if (parsed.success) out.push({ index, target: parsed.data });
  });
  return out;
}

/** The id of a goal card (`card.id`), or null. */
export function goalCardId(card: unknown): string | null {
  if (!card || typeof card !== 'object') return null;
  const id = (card as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** The progress of a benefit target: from the benefit's latest measurement. */
export function benefitTargetProgress(
  index: number,
  benefitId: string,
  benefit: Pick<Benefit, 'code' | 'title' | 'metric' | 'unit' | 'baselineValue' | 'targetValue' | 'status' | 'latest'> | null,
): GoalTargetProgress {
  if (!benefit) {
    return {
      index,
      kind: 'benefit',
      label: '',
      benefitId,
      code: null,
      metric: null,
      unit: null,
      baselineValue: null,
      currentValue: null,
      targetValue: null,
      status: null,
      done: null,
      total: null,
      progressPct: null,
    };
  }
  return {
    index,
    kind: 'benefit',
    label: benefit.title,
    benefitId,
    code: benefit.code,
    metric: benefit.metric,
    unit: benefit.unit,
    baselineValue: benefit.baselineValue,
    currentValue: benefit.latest?.value ?? null,
    targetValue: benefit.targetValue,
    status: benefit.status,
    done: null,
    total: null,
    progressPct: benefitProgress(benefit.baselineValue, benefit.targetValue, benefit.latest?.value),
  };
}

/** The progress of a task target: the tasks that match its filter. */
export function taskTargetProgress(index: number, label: string, done: number, total: number): GoalTargetProgress {
  return {
    index,
    kind: 'task',
    label,
    benefitId: null,
    code: null,
    metric: null,
    unit: null,
    baselineValue: null,
    currentValue: null,
    targetValue: null,
    status: null,
    done,
    total,
    progressPct: taskProgressPct(done, total),
  };
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/** The newest measurement of a benefit, as the routes carry it. */
export function latestOf(rows: readonly Pick<MeasurementRow, 'period' | 'value' | 'measuredAt'>[]): Benefit['latest'] {
  let best: Pick<MeasurementRow, 'period' | 'value' | 'measuredAt'> | null = null;
  for (const row of rows) if (!best || row.period > best.period) best = row;
  return best ? { period: best.period, value: best.value, measuredAt: best.measuredAt.toISOString() } : null;
}

/** A benefit as the routes answer it, with its newest measurement. */
export function presentBenefit(row: BenefitRow, latest: Benefit['latest']): Benefit {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    code: benefitCode(row.number),
    title: row.title,
    description: row.description,
    ownerId: row.ownerId,
    goalRef: row.goalRef,
    metric: row.metric,
    metricParams: row.metricParams,
    unit: row.unit,
    baselineValue: row.baselineValue,
    targetValue: row.targetValue,
    realiseBy: iso(row.realiseBy),
    status: row.status,
    closedAt: iso(row.closedAt),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: iso(row.deletedAt),
    latest,
    progressPct: benefitProgress(row.baselineValue, row.targetValue, latest?.value),
  };
}

/** One month of a benefit. */
export function presentMeasurement(row: MeasurementRow): BenefitMeasurement {
  return {
    id: row.id,
    benefitId: row.benefitId,
    projectId: row.projectId,
    period: row.period,
    value: row.value,
    measuredAt: row.measuredAt.toISOString(),
    measuredBy: row.measuredBy,
  };
}

/** The payload of a `project_benefit` event: ids and statuses, no free text beyond the title. */
export function benefitEventData(row: BenefitRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    code: benefitCode(row.number),
    title: row.title,
    status: row.status,
    ownerId: row.ownerId,
    metric: row.metric,
    goalRef: row.goalRef,
  };
}
