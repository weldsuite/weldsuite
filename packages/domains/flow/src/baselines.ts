/**
 * Baselines (design: weldflow-project-control.md; ADR FLOW-012): one versioned
 * baseline per project holds the scope, plan and budget agreed at one moment.
 * v1 is signed off by the project manager; later versions come only from an
 * approved change request (`./changes`).
 *
 * This module is the rules around the snapshot:
 *
 *   - `buildSnapshot`  what a baseline freezes, from the plan as it stands
 *   - `compareSnapshots`  the variance between two plans, computed on read
 *   - the database reads the routes and `applyApprovedChange` share
 *
 * Dates are ISO strings in a snapshot, money and hours decimal strings with
 * two decimals. Every message returned here goes to the client as it is, so
 * the Rust flow-domain (`rust/crates/flow-domain/src/baselines.rs`) answers
 * alike.
 */

import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { BaselineSnapshot, ProjectBaseline } from '@weldsuite/db/schema/project-control';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export type { BaselineSnapshot };
export type BaselineRow = ProjectBaseline;

export const BASELINE_MESSAGES = {
  alreadyBaselined: 'This project already has a baseline',
  nothingToBaseline: 'Add a milestone, a deliverable or an end date before signing off the baseline',
  notFound: 'Baseline not found',
  differentProjects: 'The two baselines belong to different projects',
  needsProjectOrFrom: 'Choose a project or a baseline to compare',
  noBaseline: 'This project has no baseline yet',
} as const;

const DAY_MS = 86_400_000;

// ── Plan state and snapshot ─────────────────────────────────────────────────

/** The plan as the project holds it now, before it is turned into a snapshot. */
export interface PlanState {
  goLive: Date | null;
  milestones: Array<{ id: string; name: string; dueDate: Date }>;
  deliverables: Array<{
    id: string;
    number: number;
    title: string;
    plannedStart: Date | null;
    plannedEnd: Date | null;
  }>;
  budgetedAmount: string | null;
  budgetedHours: string | null;
  budgetCurrency: string | null;
  scopeStatement: string | null;
}

function isoOrNull(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/** A money or hours amount as the column stores it: two decimals. Null stays null. */
export function decimal(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return toCents(value) === null ? null : fromCents(toCents(value) as bigint);
}

/** `12.5` or `'12.50'` as whole hundredths, or null when it is not a number. */
export function toCents(value: string | number): bigint | null {
  const text = typeof value === 'number' ? value.toFixed(2) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,}))?$/.exec(text);
  if (!match) return null;
  const whole = BigInt(match[2] as string);
  const fraction = BigInt(((match[3] ?? '') + '00').slice(0, 2));
  const cents = whole * 100n + fraction;
  return match[1] ? -cents : cents;
}

export function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** `to - from` of two decimal strings (a missing one counts as 0); null when both are missing. */
export function decimalDelta(from: string | null, to: string | null): string | null {
  if (from === null && to === null) return null;
  return fromCents((toCents(to ?? '0') ?? 0n) - (toCents(from ?? '0') ?? 0n));
}

/** `current + delta` of two decimal strings (a missing current counts as 0). */
export function decimalSum(current: string | null, delta: string | number): string {
  return fromCents((toCents(current ?? '0') ?? 0n) + (toCents(delta) ?? 0n));
}

/**
 * What a baseline version freezes. Milestones are in due-date order (then name,
 * then id) and deliverables in number order, so two snapshots of the same plan
 * are equal.
 */
export function buildSnapshot(plan: PlanState): BaselineSnapshot {
  const milestones = [...plan.milestones].sort(
    (a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const deliverables = [...plan.deliverables].sort((a, b) => a.number - b.number || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    goLive: isoOrNull(plan.goLive),
    milestones: milestones.map((m) => ({ id: m.id, name: m.name, dueDate: m.dueDate.toISOString() })),
    deliverables: deliverables.map((d) => ({
      id: d.id,
      number: d.number,
      title: d.title,
      plannedStart: isoOrNull(d.plannedStart),
      plannedEnd: isoOrNull(d.plannedEnd),
    })),
    budgetedAmount: decimal(plan.budgetedAmount),
    budgetedHours: decimal(plan.budgetedHours),
    budgetCurrency: plan.budgetCurrency,
    scopeStatement: plan.scopeStatement,
  };
}

/** Whether a plan has anything worth freezing: a milestone, a deliverable or a go-live. */
export function baselineIsEmpty(plan: Pick<PlanState, 'goLive' | 'milestones' | 'deliverables'>): boolean {
  return plan.goLive === null && plan.milestones.length === 0 && plan.deliverables.length === 0;
}

// ── Variance ────────────────────────────────────────────────────────────────

/** Whole days `to` is after `from` (negative: earlier); null when either end is missing. */
export function dayDelta(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

export type PlanChange = 'unchanged' | 'moved' | 'added' | 'removed';

export interface Variance {
  from: string | null;
  to: string | null;
  deltaDays: number | null;
}

function variance(from: string | null, to: string | null): Variance {
  return { from, to, deltaDays: dayDelta(from, to) };
}

export interface BaselineDiff {
  goLive: Variance;
  milestones: Array<Variance & { id: string; name: string; change: PlanChange }>;
  deliverables: Array<{
    id: string;
    number: number;
    title: string;
    change: PlanChange;
    start: Variance;
    end: Variance;
  }>;
  budget: { from: string | null; to: string | null; delta: string | null };
  hours: { from: string | null; to: string | null; delta: string | null };
}

/**
 * The difference between two plans: `from` is the agreed one, `to` the one
 * compared (a later version, or the live plan). A milestone or deliverable is
 * `moved` when a date differs, `added` when only `to` has it and `removed` when
 * only `from` has it. Milestones come in `to` date order (a removed one by its
 * old date), deliverables in number order.
 */
export function compareSnapshots(from: BaselineSnapshot, to: BaselineSnapshot): BaselineDiff {
  const toMilestones = new Map(to.milestones.map((m) => [m.id, m]));
  const fromMilestones = new Map(from.milestones.map((m) => [m.id, m]));
  const milestones: BaselineDiff['milestones'] = [];
  for (const old of from.milestones) {
    const now = toMilestones.get(old.id);
    if (!now) {
      milestones.push({ id: old.id, name: old.name, change: 'removed', ...variance(old.dueDate, null) });
    } else {
      milestones.push({
        id: old.id,
        name: now.name,
        change: sameInstant(old.dueDate, now.dueDate) ? 'unchanged' : 'moved',
        ...variance(old.dueDate, now.dueDate),
      });
    }
  }
  for (const now of to.milestones) {
    if (!fromMilestones.has(now.id)) {
      milestones.push({ id: now.id, name: now.name, change: 'added', ...variance(null, now.dueDate) });
    }
  }
  milestones.sort((a, b) => {
    const at = new Date(a.to ?? a.from ?? 0).getTime();
    const bt = new Date(b.to ?? b.from ?? 0).getTime();
    return at - bt || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });

  const toDeliverables = new Map(to.deliverables.map((d) => [d.id, d]));
  const fromDeliverables = new Map(from.deliverables.map((d) => [d.id, d]));
  const deliverables: BaselineDiff['deliverables'] = [];
  for (const old of from.deliverables) {
    const now = toDeliverables.get(old.id);
    if (!now) {
      deliverables.push({
        id: old.id,
        number: old.number,
        title: old.title,
        change: 'removed',
        start: variance(old.plannedStart, null),
        end: variance(old.plannedEnd, null),
      });
    } else {
      const unchanged = sameInstant(old.plannedStart, now.plannedStart) && sameInstant(old.plannedEnd, now.plannedEnd);
      deliverables.push({
        id: old.id,
        number: now.number,
        title: now.title,
        change: unchanged ? 'unchanged' : 'moved',
        start: variance(old.plannedStart, now.plannedStart),
        end: variance(old.plannedEnd, now.plannedEnd),
      });
    }
  }
  for (const now of to.deliverables) {
    if (!fromDeliverables.has(now.id)) {
      deliverables.push({
        id: now.id,
        number: now.number,
        title: now.title,
        change: 'added',
        start: variance(null, now.plannedStart),
        end: variance(null, now.plannedEnd),
      });
    }
  }
  deliverables.sort((a, b) => a.number - b.number || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    goLive: variance(from.goLive, to.goLive),
    milestones,
    deliverables,
    budget: { from: from.budgetedAmount, to: to.budgetedAmount, delta: decimalDelta(from.budgetedAmount, to.budgetedAmount) },
    hours: { from: from.budgetedHours, to: to.budgetedHours, delta: decimalDelta(from.budgetedHours, to.budgetedHours) },
  };
}

// ── Database ────────────────────────────────────────────────────────────────

const baselines = schema.projectBaselines;

/** The plan of a live project as it stands now, or null when the project is gone. */
export async function loadPlanState(db: Database, projectId: string): Promise<(PlanState & { projectManagerId: string | null }) | null> {
  const [project] = await db
    .select({
      endDate: schema.projects.endDate,
      budgetedAmount: schema.projects.budgetedAmount,
      budgetedHours: schema.projects.budgetedHours,
      budgetCurrency: schema.projects.budgetCurrency,
      projectManagerId: schema.projects.projectManagerId,
    })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)))
    .limit(1);
  if (!project) return null;
  const [milestoneRows, deliverableRows, [scope]] = await Promise.all([
    db
      .select({ id: schema.milestones.id, name: schema.milestones.name, dueDate: schema.milestones.dueDate })
      .from(schema.milestones)
      .where(and(eq(schema.milestones.projectId, projectId), isNull(schema.milestones.deletedAt)))
      .orderBy(asc(schema.milestones.dueDate), asc(schema.milestones.id)),
    db
      .select({
        id: schema.projectDeliverables.id,
        number: schema.projectDeliverables.number,
        title: schema.projectDeliverables.title,
        plannedStart: schema.projectDeliverables.plannedStart,
        plannedEnd: schema.projectDeliverables.plannedEnd,
      })
      .from(schema.projectDeliverables)
      .where(and(eq(schema.projectDeliverables.projectId, projectId), isNull(schema.projectDeliverables.deletedAt)))
      .orderBy(asc(schema.projectDeliverables.number)),
    db.select({ statement: schema.projectScope.statement }).from(schema.projectScope).where(eq(schema.projectScope.projectId, projectId)).limit(1),
  ]);
  return {
    goLive: project.endDate,
    milestones: milestoneRows,
    deliverables: deliverableRows,
    budgetedAmount: project.budgetedAmount,
    budgetedHours: project.budgetedHours,
    budgetCurrency: project.budgetCurrency,
    scopeStatement: scope?.statement ?? null,
    projectManagerId: project.projectManagerId,
  };
}

/** The newest baseline version of a project, or null while it has none. */
export async function latestBaseline(db: Database, projectId: string): Promise<BaselineRow | null> {
  const [row] = await db.select().from(baselines).where(eq(baselines.projectId, projectId)).orderBy(desc(baselines.version)).limit(1);
  return row ?? null;
}

/** A baseline by id. */
export async function findBaseline(db: Database, id: string): Promise<BaselineRow | null> {
  const [row] = await db.select().from(baselines).where(eq(baselines.id, id)).limit(1);
  return row ?? null;
}

// ── Presenting ──────────────────────────────────────────────────────────────

export interface PresentedBaseline {
  id: string;
  projectId: string;
  version: number;
  changeRequestId: string | null;
  changeRequestCode: string | null;
  changeRequestTitle: string | null;
  snapshot: BaselineSnapshot;
  createdBy: string;
  createdAt: string;
}

/** A baseline as the routes answer it, with the code and title of the change that produced it. */
export function presentBaseline(row: BaselineRow, change: { code: string; title: string } | null): PresentedBaseline {
  return {
    id: row.id,
    projectId: row.projectId,
    version: row.version,
    changeRequestId: row.changeRequestId,
    changeRequestCode: change?.code ?? null,
    changeRequestTitle: change?.title ?? null,
    snapshot: row.snapshot,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The payload of a `project_baseline` event. */
export function baselineEventData(row: BaselineRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    version: row.version,
    changeRequestId: row.changeRequestId,
    createdBy: row.createdBy,
  };
}
