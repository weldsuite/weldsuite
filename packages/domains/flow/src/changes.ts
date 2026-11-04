/**
 * Change requests (design: weldflow-project-control.md; ADRs FLOW-012 and
 * FLOW-013): the rules of the routing, the validation of the impact, "what
 * changes once approved", and `applyApprovedChange`, which writes an approved
 * change to the plan, the budget, the baseline and the decision log in one
 * batch.
 *
 * Two layers, so the Rust flow-domain can mirror it one to one:
 *
 *   1. Pure functions and constants (no database, no clock): routing, impact
 *      checks, effects, the shapes on the wire. Every message returned here is
 *      sent to the client as it is.
 *   2. Database functions (`applyApprovedChange`, `recordRejectedChange`), which
 *      take `now`.
 *
 * The approvers' answers are `flow_approvals` rows, subject type
 * `change_request` (FLOW-016); `registerApprovalSubject` is called by the
 * flow-api service that owns the subject, not here.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  ChangePlanChanges,
  ChangeRequestStatus,
  ChangeRoute,
  ChangeScopeChanges,
  DecisionOption,
  ProjectChangeRequest,
  ProjectDecision,
} from '@weldsuite/db/schema/project-control';
import { DEFAULT_CHANGE_CONTROL, type ProjectChangeControlSettings, type ProjectSettings } from '@weldsuite/db/schema/project-settings';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { ApprovalRow, ApprovalRowInput } from './approvals';
import {
  buildSnapshot,
  dayDelta,
  decimal,
  decimalSum,
  latestBaseline,
  loadPlanState,
  type BaselineRow,
  type PlanState,
} from './baselines';
import { allocateNumber, allocateNumbers, type NumberSequence } from './task-numbering';
import { compareText } from './compare';

export type ChangeRequestRow = ProjectChangeRequest;
export type { ChangePlanChanges, ChangeRequestStatus, ChangeRoute, ChangeScopeChanges };

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** The statuses from which a change can still be edited, submitted or withdrawn. */
export const OPEN_CHANGE_STATUSES = ['draft', 'assessing', 'awaiting_approval'] as const;

/** How long the approvers get, in days from submission. */
export const CHANGE_APPROVAL_DUE_DAYS = 5;

export const CHANGE_MESSAGES = {
  notEditable: 'This change request can no longer be edited',
  notSubmittable: 'Only a draft or assessing change request can be submitted',
  notWithdrawable: 'Only an open change request can be withdrawn',
  notDeletable: 'Only a draft or withdrawn change request can be deleted',
  withdrawDenied: 'Only the requester or a project manager can withdraw this change request',
  noManager: 'This project has no project manager to approve the change',
  boardNotMembers: 'Change board members must be members of this project',
  twiceMilestone: 'A milestone can be moved only once in a change request',
  twiceDeliverable: 'A deliverable can be moved only once in a change request',
  movedAndRemoved: 'A deliverable cannot be moved and removed in the same change request',
  startAfterEnd: 'A deliverable cannot start after it ends',
} as const;

export function unknownMilestoneMessage(id: string): string {
  return `Milestone ${id} does not belong to this project`;
}

export function unknownDeliverableMessage(id: string): string {
  return `Deliverable ${id} does not belong to this project`;
}

export function isOpenChange(status: string): boolean {
  return (OPEN_CHANGE_STATUSES as readonly string[]).includes(status);
}

// ── Numbering ───────────────────────────────────────────────────────────────

/** The change request counter of one project: scope `cr:<projectId>`, prefix `CR-`. */
export function changeSequence(projectId: string): NumberSequence {
  return { scope: `cr:${projectId}`, prefix: 'CR-' };
}

/** `CR-8`. */
export function changeCode(number: number): string {
  return `CR-${number}`;
}

/** The decision counter of one project: scope `dec:<projectId>`, prefix `DEC-`. */
export function decisionSequence(projectId: string): NumberSequence {
  return { scope: `dec:${projectId}`, prefix: 'DEC-' };
}

/** The deliverable counter of one project: scope `del:<projectId>`, prefix `D`. */
export function deliverableSequence(projectId: string): NumberSequence {
  return { scope: `del:${projectId}`, prefix: 'D' };
}

export function decisionCode(number: number): string {
  return `DEC-${number}`;
}

export function deliverableCode(number: number): string {
  return `D${number}`;
}

// ── Routing (FLOW-013) ──────────────────────────────────────────────────────

/** A project's change control rules: its own limits and board over the defaults. */
export function effectiveChangeControl(settings: Pick<ProjectSettings, 'changeControl'> | null | undefined): ProjectChangeControlSettings {
  const own = settings?.changeControl;
  const costLimit = typeof own?.costLimit === 'number' && Number.isFinite(own.costLimit) ? own.costLimit : DEFAULT_CHANGE_CONTROL.costLimit;
  const scheduleLimitDays =
    typeof own?.scheduleLimitDays === 'number' && Number.isFinite(own.scheduleLimitDays)
      ? own.scheduleLimitDays
      : DEFAULT_CHANGE_CONTROL.scheduleLimitDays;
  const board = Array.isArray(own?.boardMemberIds) ? own.boardMemberIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  return { costLimit, scheduleLimitDays, boardMemberIds: [...new Set(board)] };
}

export interface ChangeRouting {
  route: ChangeRoute;
  /** The cost delta or the delay reached a limit. */
  overLimit: boolean;
  /** Over a limit, with no board to send it to: the project manager approves. */
  noBoard: boolean;
  costLimit: number;
  scheduleLimitDays: number;
  /** Who is asked, in order. Empty only when the project has no manager (and no board applies). */
  approverIds: string[];
  ruleCode: 'change_manager' | 'change_board_over_limit';
  /** The parameters stored with each approval (`flow_approvals.rule.params`). */
  params: {
    costDelta: number | null;
    costLimit: number;
    scheduleDeltaDays: number | null;
    scheduleLimitDays: number;
    overLimit: boolean;
    noBoard: boolean;
  };
}

function amountOf(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Who approves a change: the project manager when the cost delta is below the
 * cost limit and the delay below the schedule limit (a change that saves money
 * or time stays with the manager), otherwise the change board, every member of
 * which has to approve. With no board, everything goes to the project manager
 * and `noBoard` flags it. A missing delta counts as 0.
 */
export function routeChange(input: {
  costDelta: string | number | null | undefined;
  scheduleDeltaDays: number | null | undefined;
  settings: Pick<ProjectSettings, 'changeControl'> | null | undefined;
  projectManagerId: string | null | undefined;
}): ChangeRouting {
  const control = effectiveChangeControl(input.settings);
  const costDelta = amountOf(input.costDelta);
  const scheduleDeltaDays = input.scheduleDeltaDays ?? null;
  const overLimit = (costDelta ?? 0) >= control.costLimit || (scheduleDeltaDays ?? 0) >= control.scheduleLimitDays;
  const board = control.boardMemberIds;
  const toBoard = overLimit && board.length > 0;
  const noBoard = overLimit && board.length === 0;
  const manager = input.projectManagerId || null;
  const managerIds = manager ? [manager] : [];
  return {
    route: toBoard ? 'board' : 'manager',
    overLimit,
    noBoard,
    costLimit: control.costLimit,
    scheduleLimitDays: control.scheduleLimitDays,
    approverIds: toBoard ? board : managerIds,
    ruleCode: toBoard ? 'change_board_over_limit' : 'change_manager',
    params: {
      costDelta,
      costLimit: control.costLimit,
      scheduleDeltaDays,
      scheduleLimitDays: control.scheduleLimitDays,
      overLimit,
      noBoard,
    },
  };
}

/** The approval rows a routed change asks for, all in step 1 and due `dueAt`. */
export function changeApproverRows(routing: ChangeRouting, dueAt: Date): ApprovalRowInput[] {
  return routing.approverIds.map((approverId) => ({
    approverId,
    roleLabel: routing.route === 'board' ? 'Change board' : 'Project manager',
    rule: { code: routing.ruleCode, params: { ...routing.params } },
    dueAt,
  }));
}

/** The members who are not on the project, among the board members named. */
export function boardOutsiders(boardMemberIds: readonly string[], projectMemberIds: ReadonlySet<string>): string[] {
  return boardMemberIds.filter((id) => !projectMemberIds.has(id));
}

// ── Impact checks ───────────────────────────────────────────────────────────

/**
 * The refusal for an impact that points at things the project does not have, or
 * contradicts itself, or null. The order is fixed: milestone moves, deliverable
 * moves, removals, then the dates.
 */
export function changeImpactError(
  impact: { planChanges?: ChangePlanChanges | null; scopeChanges?: ChangeScopeChanges | null },
  known: { milestoneIds: ReadonlySet<string>; deliverableIds: ReadonlySet<string> },
): string | null {
  const plan = impact.planChanges ?? {};
  const scope = impact.scopeChanges ?? {};
  const moved = new Set<string>();
  const moveError = planMoveError(plan, known, moved);
  if (moveError) return moveError;
  const removeError = scopeRemoveError(scope, known, moved);
  if (removeError) return removeError;
  return plannedDatesError(plan, scope);
}

/** The milestone and deliverable moves of a plan change, or the first refusal; `movedDeliverables` collects the moved ids. */
function planMoveError(
  plan: ChangePlanChanges,
  known: { milestoneIds: ReadonlySet<string>; deliverableIds: ReadonlySet<string> },
  movedDeliverables: Set<string>,
): string | null {
  const movedMilestones = new Set<string>();
  for (const move of plan.milestones ?? []) {
    if (!known.milestoneIds.has(move.milestoneId)) return unknownMilestoneMessage(move.milestoneId);
    if (movedMilestones.has(move.milestoneId)) return CHANGE_MESSAGES.twiceMilestone;
    movedMilestones.add(move.milestoneId);
  }
  for (const move of plan.deliverables ?? []) {
    if (!known.deliverableIds.has(move.deliverableId)) return unknownDeliverableMessage(move.deliverableId);
    if (movedDeliverables.has(move.deliverableId)) return CHANGE_MESSAGES.twiceDeliverable;
    movedDeliverables.add(move.deliverableId);
  }
  return null;
}

function scopeRemoveError(
  scope: ChangeScopeChanges,
  known: { deliverableIds: ReadonlySet<string> },
  movedDeliverables: ReadonlySet<string>,
): string | null {
  for (const id of scope.remove ?? []) {
    if (!known.deliverableIds.has(id)) return unknownDeliverableMessage(id);
    if (movedDeliverables.has(id)) return CHANGE_MESSAGES.movedAndRemoved;
  }
  return null;
}

function plannedDatesError(plan: ChangePlanChanges, scope: ChangeScopeChanges): string | null {
  const ranges = [
    ...(plan.deliverables ?? []).map((move) => [move.plannedStart, move.plannedEnd] as const),
    ...(scope.add ?? []).map((added) => [added.plannedStart, added.plannedEnd] as const),
  ];
  for (const [start, end] of ranges) {
    if (start && end && new Date(start).getTime() > new Date(end).getTime()) return CHANGE_MESSAGES.startAfterEnd;
  }
  return null;
}

/** Whether an edit changes what the approvers weigh: the cost, the delay or the plan and scope changes. */
export function touchesImpact(data: Record<string, unknown>): boolean {
  return ['costDelta', 'scheduleDeltaDays', 'planChanges', 'scopeChanges'].some((key) => data[key] !== undefined);
}

// ── Effects ("what changes once approved") ──────────────────────────────────

export interface ChangeEffects {
  goLive: { from: string | null; to: string | null; deltaDays: number | null } | null;
  milestones: Array<{ id: string; name: string; from: string | null; to: string; deltaDays: number | null }>;
  deliverables: {
    moved: Array<{ id: string; code: string | null; title: string; plannedStart: string | null; plannedEnd: string | null }>;
    added: Array<{ title: string; plannedStart: string | null; plannedEnd: string | null }>;
    removed: Array<{ id: string; code: string | null; title: string }>;
  };
  budget: { currency: string | null; from: string | null; to: string | null; delta: string } | null;
}

/** A date a change moves to: left as it is when the change says nothing, cleared when it says null. */
function movedDate(moved: string | Date | null | undefined, current: Date | null): Date | null {
  if (moved === undefined) return current;
  return moved ? new Date(moved) : null;
}

function isoOf(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

/**
 * What the change does to the plan, from the change and the plan as it stands.
 * For a change that is already applied the live plan holds the "after" values,
 * so the dates it moved from are unknown (`from` is null) and the budget's
 * `from` is the live amount less the change.
 */
export function computeEffects(
  change: Pick<ProjectChangeRequest, 'planChanges' | 'scopeChanges' | 'costDelta'>,
  plan: PlanState,
  applied: boolean,
): ChangeEffects {
  const planChanges = change.planChanges ?? {};
  const scopeChanges = change.scopeChanges ?? {};
  const milestones = milestoneEffects(planChanges, plan, applied);
  const moved = movedDeliverableEffects(planChanges, plan);
  const added = (scopeChanges.add ?? []).map((item) => ({
    title: item.title,
    plannedStart: isoOf(item.plannedStart),
    plannedEnd: isoOf(item.plannedEnd),
  }));
  const removed: ChangeEffects['deliverables']['removed'] = [];
  for (const id of scopeChanges.remove ?? []) {
    const current = plan.deliverables.find((d) => d.id === id);
    if (current) removed.push({ id, code: deliverableCode(current.number), title: current.title });
  }
  const goLiveTo = planChanges.goLive ? isoOf(planChanges.goLive) : null;
  const goLiveFrom = applied ? null : isoOf(plan.goLive);
  return {
    goLive: goLiveTo ? { from: goLiveFrom, to: goLiveTo, deltaDays: dayDelta(goLiveFrom, goLiveTo) } : null,
    milestones,
    deliverables: { moved, added, removed },
    budget: budgetEffect(amountOf(change.costDelta), plan, applied),
  };
}

function milestoneEffects(planChanges: ChangePlanChanges, plan: PlanState, applied: boolean): ChangeEffects['milestones'] {
  const milestones: ChangeEffects['milestones'] = [];
  for (const move of planChanges.milestones ?? []) {
    const current = plan.milestones.find((m) => m.id === move.milestoneId);
    if (!current) continue;
    const from = applied ? null : current.dueDate.toISOString();
    const to = isoOf(move.to) as string;
    milestones.push({ id: current.id, name: current.name, from, to, deltaDays: dayDelta(from, to) });
  }
  return milestones;
}

function movedDeliverableEffects(planChanges: ChangePlanChanges, plan: PlanState): ChangeEffects['deliverables']['moved'] {
  const moved: ChangeEffects['deliverables']['moved'] = [];
  for (const move of planChanges.deliverables ?? []) {
    const current = plan.deliverables.find((d) => d.id === move.deliverableId);
    if (!current) continue;
    moved.push({
      id: current.id,
      code: deliverableCode(current.number),
      title: current.title,
      plannedStart: move.plannedStart !== undefined ? isoOf(move.plannedStart) : isoOf(current.plannedStart),
      plannedEnd: move.plannedEnd !== undefined ? isoOf(move.plannedEnd) : isoOf(current.plannedEnd),
    });
  }
  return moved;
}

function budgetEffect(delta: number | null, plan: PlanState, applied: boolean): ChangeEffects['budget'] {
  if (delta === null || delta === 0) return null;
  const live = decimal(plan.budgetedAmount);
  const currency = plan.budgetCurrency;
  if (applied) return { currency, from: decimalSum(live, -delta), to: live, delta: decimal(delta) as string };
  return { currency, from: live, to: decimalSum(live, delta), delta: decimal(delta) as string };
}

/** The date (`2026-11-24`) of an ISO timestamp, for the lines of a decision's consequences. */
function dayOf(iso: string | null): string {
  return iso ? iso.slice(0, 10) : 'no date';
}

/** One plain line per effect, for the decision a change records. */
export function consequenceLines(effects: ChangeEffects): string[] {
  const lines: string[] = [];
  if (effects.goLive) lines.push(`Go-live moves to ${dayOf(effects.goLive.to)}`);
  for (const m of effects.milestones) lines.push(`Milestone "${m.name}" moves to ${dayOf(m.to)}`);
  for (const d of effects.deliverables.moved) lines.push(`Deliverable ${d.code} "${d.title}" is rescheduled`);
  for (const d of effects.deliverables.added) lines.push(`Deliverable "${d.title}" is added to the scope`);
  for (const d of effects.deliverables.removed) lines.push(`Deliverable ${d.code} "${d.title}" is removed from the scope`);
  if (effects.budget) {
    const raised = effects.budget.delta.startsWith('-') ? 'falls' : 'rises';
    const amount = effects.budget.delta.replace(/^-/, '');
    const unit = effects.budget.currency ? ` ${effects.budget.currency}` : '';
    lines.push(`The budget ${raised} by ${amount}${unit}`);
  }
  return lines;
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** A change request as the routes answer it. */
export function presentChangeRequest(row: ChangeRequestRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    code: changeCode(row.number),
    title: row.title,
    description: row.description,
    requestedBy: row.requestedBy,
    requestedByName: row.requestedByName,
    status: row.status,
    costDelta: row.costDelta,
    scheduleDeltaDays: row.scheduleDeltaDays,
    planChanges: row.planChanges ?? null,
    scopeChanges: row.scopeChanges ?? null,
    route: row.route,
    submittedAt: iso(row.submittedAt),
    decidedAt: iso(row.decidedAt),
    baselineId: row.baselineId,
    clientVisible: row.clientVisible,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: iso(row.deletedAt),
  };
}

/** The payload of a `project_change_request` event: ids and statuses, and the impact figures (FLOW-013). */
export function changeEventData(row: ChangeRequestRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    code: changeCode(row.number),
    title: row.title,
    status: row.status,
    route: row.route,
    costDelta: row.costDelta,
    scheduleDeltaDays: row.scheduleDeltaDays,
    requestedBy: row.requestedBy,
  };
}

/** The payload of a `project_decision` event. */
export function decisionEventData(row: ProjectDecision) {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    code: decisionCode(row.number),
    title: row.title,
    status: row.status,
    decidedBy: row.decidedBy,
  };
}

// ── Database ────────────────────────────────────────────────────────────────

const changes = schema.projectChangeRequests;
const decisions = schema.projectDecisions;
const deliverables = schema.projectDeliverables;
const baselines = schema.projectBaselines;

/** A live change request by id. */
export async function findChangeRequest(db: Database, id: string): Promise<ChangeRequestRow | null> {
  const [row] = await db
    .select()
    .from(changes)
    .where(and(eq(changes.id, id), isNull(changes.deletedAt)))
    .limit(1);
  return row ?? null;
}

const TITLE_MAX = 255;

function clip(text: string): string {
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1).trimEnd()}…` : text;
}

/** What `applyApprovedChange` did. */
export interface AppliedChange {
  /** `skipped`: the change was not waiting for approval (already applied, withdrawn, edited), so nothing was written. */
  outcome: 'applied' | 'skipped';
  change: ChangeRequestRow | null;
  /** The new baseline version; null when the project had no baseline to move (FLOW-012: v1 is the manager's sign-off). */
  baseline: BaselineRow | null;
  decision: ProjectDecision | null;
}

/**
 * Write an approved change request to the project in one batch (FLOW-012):
 *
 *   - the milestone, deliverable and go-live date moves of `plan_changes`
 *   - the deliverables `scope_changes` adds and removes (a removed deliverable
 *     lets go of its tasks)
 *   - the budget (`cost_delta` added to `budgeted_amount`)
 *   - the next baseline version, of the plan as it is after those writes
 *     (none while the project has no baseline: v1 is the manager's own sign-off)
 *   - a decided decision that records the approval
 *   - the change itself: `approved`, with the baseline it produced
 *
 * Idempotent: a change that is no longer `awaiting_approval` is left alone.
 */
export async function applyApprovedChange(
  db: Database,
  changeId: string,
  ctx: { actorId: string | null; rows?: readonly ApprovalRow[]; now?: Date },
): Promise<AppliedChange> {
  const now = ctx.now ?? new Date();
  const change = await findChangeRequest(db, changeId);
  if (!change || change.status !== 'awaiting_approval') return { outcome: 'skipped', change, baseline: null, decision: null };
  const plan = await loadPlanState(db, change.projectId);
  if (!plan) return { outcome: 'skipped', change, baseline: null, decision: null };

  const actor = ctx.actorId ?? change.createdBy;
  const planChanges = change.planChanges ?? {};
  const scopeChanges = change.scopeChanges ?? {};
  const effects = computeEffects(change, plan, false);

  // The plan as it will be once the writes below have run.
  const milestoneMoves = (planChanges.milestones ?? []).filter((move) => plan.milestones.some((m) => m.id === move.milestoneId));
  const deliverableMoves = (planChanges.deliverables ?? []).filter((move) => plan.deliverables.some((d) => d.id === move.deliverableId));
  const removeIds = (scopeChanges.remove ?? []).filter((id) => plan.deliverables.some((d) => d.id === id));
  const adds = scopeChanges.add ?? [];
  const numbers = await allocateNumbers(db, deliverableSequence(change.projectId), adds.length);
  const [positionRow] = await db
    .select({ max: sql<number>`coalesce(max(${deliverables.position}), 0)`.mapWith(Number) })
    .from(deliverables)
    .where(and(eq(deliverables.projectId, change.projectId), isNull(deliverables.deletedAt)));
  const firstPosition = (positionRow?.max ?? 0) + 1;
  const addedRows = adds.map((item, index) => ({
    id: generateId('del'),
    number: numbers[index] as number,
    item,
    position: firstPosition + index,
  }));

  const after: PlanState = {
    ...plan,
    goLive: planChanges.goLive ? new Date(planChanges.goLive) : plan.goLive,
    milestones: plan.milestones.map((m) => {
      const move = milestoneMoves.find((x) => x.milestoneId === m.id);
      return move ? { ...m, dueDate: new Date(move.to) } : m;
    }),
    deliverables: [
      ...plan.deliverables
        .filter((d) => !removeIds.includes(d.id))
        .map((d) => {
          const move = deliverableMoves.find((x) => x.deliverableId === d.id);
          if (!move) return d;
          return {
            ...d,
            plannedStart: movedDate(move.plannedStart, d.plannedStart),
            plannedEnd: movedDate(move.plannedEnd, d.plannedEnd),
          };
        }),
      ...addedRows.map(({ id, number, item }) => ({
        id,
        number,
        title: item.title,
        plannedStart: item.plannedStart ? new Date(item.plannedStart) : null,
        plannedEnd: item.plannedEnd ? new Date(item.plannedEnd) : null,
      })),
    ],
    budgetedAmount: effects.budget ? effects.budget.to : plan.budgetedAmount,
  };

  const previous = await latestBaseline(db, change.projectId);
  const baselineRow: typeof baselines.$inferInsert | null = previous
    ? {
        id: generateId('bsl'),
        projectId: change.projectId,
        version: previous.version + 1,
        changeRequestId: change.id,
        snapshot: buildSnapshot(after),
        createdBy: actor,
        createdAt: now,
      }
    : null;

  const code = changeCode(change.number);
  const decisionNumber = await allocateNumber(db, decisionSequence(change.projectId));
  const decisionRow: typeof decisions.$inferInsert = {
    id: generateId('dec'),
    projectId: change.projectId,
    number: decisionNumber,
    title: clip(`${code}: ${change.title}`),
    status: 'decided',
    context: [`Change request ${code} was approved.`, change.description].filter(Boolean).join('\n\n'),
    options: [
      { title: 'Approve the change', note: null, chosen: true },
      { title: 'Reject the change', note: null, chosen: false },
    ] satisfies DecisionOption[],
    consequences: consequenceLines(effects),
    decidedBy: actor,
    decidedAt: now,
    createdBy: change.createdBy,
    createdAt: now,
    updatedAt: now,
  };

  const projectSet: Partial<typeof schema.projects.$inferInsert> = { updatedAt: now };
  if (planChanges.goLive) projectSet.endDate = new Date(planChanges.goLive);
  if (effects.budget) projectSet.budgetedAmount = effects.budget.to;

  const recordedScope: ChangeScopeChanges | null = change.scopeChanges
    ? { ...scopeChanges, ...(adds.length > 0 ? { add: adds.map((item, index) => ({ ...item, deliverableId: addedRows[index]?.id })) } : {}) }
    : null;

  await atomically(db, (handle) => [
    ...milestoneMoves.map((move) =>
      handle
        .update(schema.milestones)
        .set({ dueDate: new Date(move.to), updatedAt: now })
        .where(and(eq(schema.milestones.id, move.milestoneId), eq(schema.milestones.projectId, change.projectId), isNull(schema.milestones.deletedAt))),
    ),
    ...deliverableMoves.map((move) =>
      handle
        .update(deliverables)
        .set({
          ...(move.plannedStart !== undefined ? { plannedStart: move.plannedStart ? new Date(move.plannedStart) : null } : {}),
          ...(move.plannedEnd !== undefined ? { plannedEnd: move.plannedEnd ? new Date(move.plannedEnd) : null } : {}),
          updatedAt: now,
        })
        .where(and(eq(deliverables.id, move.deliverableId), eq(deliverables.projectId, change.projectId), isNull(deliverables.deletedAt))),
    ),
    ...(removeIds.length > 0
      ? [
          handle
            .update(deliverables)
            .set({ deletedAt: now, updatedAt: now })
            .where(and(inArray(deliverables.id, removeIds), eq(deliverables.projectId, change.projectId), isNull(deliverables.deletedAt))),
          handle.update(schema.tasks).set({ deliverableId: null, updatedAt: now }).where(inArray(schema.tasks.deliverableId, removeIds)),
        ]
      : []),
    ...addedRows.map(({ id, number, item, position }) =>
      handle.insert(deliverables).values({
        id,
        projectId: change.projectId,
        number,
        title: item.title,
        description: item.description ?? null,
        ownerId: item.ownerId ?? null,
        status: 'not_started',
        plannedStart: item.plannedStart ? new Date(item.plannedStart) : null,
        plannedEnd: item.plannedEnd ? new Date(item.plannedEnd) : null,
        acceptanceCriteria: [],
        position,
        clientVisible: false,
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
      }),
    ),
    ...(Object.keys(projectSet).length > 1
      ? [handle.update(schema.projects).set(projectSet).where(eq(schema.projects.id, change.projectId))]
      : []),
    ...(baselineRow ? [handle.insert(baselines).values(baselineRow)] : []),
    handle.insert(decisions).values(decisionRow),
    handle
      .update(changes)
      .set({
        status: 'approved',
        decidedAt: now,
        baselineId: baselineRow?.id ?? null,
        scopeChanges: recordedScope,
        updatedAt: now,
      })
      .where(and(eq(changes.id, change.id), eq(changes.status, 'awaiting_approval'))),
  ]);

  const [updated, baseline, decision] = await Promise.all([
    findChangeRequest(db, change.id),
    baselineRow ? db.select().from(baselines).where(eq(baselines.id, baselineRow.id)).limit(1).then((rows) => rows[0] ?? null) : Promise.resolve(null),
    db.select().from(decisions).where(eq(decisions.id, decisionRow.id as string)).limit(1).then((rows) => rows[0] ?? null),
  ]);
  return { outcome: 'applied', change: updated, baseline, decision };
}

/**
 * Record a rejected change (FLOW-013): `rejected`, and a decided decision with
 * the reason the rejecting approver gave. Idempotent: a change that is no
 * longer `awaiting_approval` is left alone.
 */
export async function recordRejectedChange(
  db: Database,
  changeId: string,
  ctx: { actorId: string | null; rows: readonly ApprovalRow[]; now?: Date },
): Promise<AppliedChange> {
  const now = ctx.now ?? new Date();
  const change = await findChangeRequest(db, changeId);
  if (!change || change.status !== 'awaiting_approval') return { outcome: 'skipped', change, baseline: null, decision: null };

  const rejecting = ctx.rows.find((row) => row.decision === 'rejected');
  const actor = rejecting?.decidedBy ?? ctx.actorId ?? change.createdBy;
  const code = changeCode(change.number);
  const decisionNumber = await allocateNumber(db, decisionSequence(change.projectId));
  const reason = rejecting?.note ? `Reason: ${rejecting.note}` : null;
  const decisionRow: typeof decisions.$inferInsert = {
    id: generateId('dec'),
    projectId: change.projectId,
    number: decisionNumber,
    title: clip(`${code} rejected: ${change.title}`),
    status: 'decided',
    context: [`Change request ${code} was rejected.`, reason, change.description].filter(Boolean).join('\n\n'),
    options: [
      { title: 'Approve the change', note: null, chosen: false },
      { title: 'Reject the change', note: rejecting?.note ?? null, chosen: true },
    ] satisfies DecisionOption[],
    consequences: ['The change was not applied.'],
    decidedBy: actor,
    decidedAt: now,
    createdBy: change.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await atomically(db, (handle) => [
    handle.insert(decisions).values(decisionRow),
    handle
      .update(changes)
      .set({ status: 'rejected', decidedAt: now, updatedAt: now })
      .where(and(eq(changes.id, change.id), eq(changes.status, 'awaiting_approval'))),
  ]);
  const [updated, decision] = await Promise.all([
    findChangeRequest(db, change.id),
    db.select().from(decisions).where(eq(decisions.id, decisionRow.id as string)).limit(1).then((rows) => rows[0] ?? null),
  ]);
  return { outcome: 'applied', change: updated, baseline: null, decision };
}

/** The open change requests of a project that would move the plan, newest first (the Gantt's dashed previews). */
export async function listPendingChanges(db: Database, projectId: string): Promise<ChangeRequestRow[]> {
  return db
    .select()
    .from(changes)
    .where(and(eq(changes.projectId, projectId), isNull(changes.deletedAt), inArray(changes.status, ['assessing', 'awaiting_approval'])))
    .orderBy(desc(changes.createdAt), desc(changes.id));
}

// ── Edits ───────────────────────────────────────────────────────────────────

/** JSON with the keys of every object in order, so two equal values print alike. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareText(a, b));
    const members = entries.map(([k, v]) => JSON.stringify(k) + ':' + stableJson(v));
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Whether an edit really changes what the approvers weigh: a field of the impact
 * that is present in `data` and differs from the stored change. Sending the same
 * impact again (a form that posts every field) is not a change.
 */
export function impactChanged(
  existing: Pick<ProjectChangeRequest, 'costDelta' | 'scheduleDeltaDays' | 'planChanges' | 'scopeChanges'>,
  data: {
    costDelta?: number | null;
    scheduleDeltaDays?: number | null;
    planChanges?: unknown;
    scopeChanges?: unknown;
  },
): boolean {
  if (data.costDelta !== undefined && amountOf(data.costDelta) !== amountOf(existing.costDelta)) return true;
  if (data.scheduleDeltaDays !== undefined && (data.scheduleDeltaDays ?? null) !== existing.scheduleDeltaDays) return true;
  if (data.planChanges !== undefined && stableJson(data.planChanges) !== stableJson(existing.planChanges)) return true;
  if (data.scopeChanges !== undefined && stableJson(data.scopeChanges) !== stableJson(existing.scopeChanges)) return true;
  return false;
}

/** What the routes tell the client about how a change was routed (`changeRoutingSchema`): the route and why. */
export function presentRouting(routing: Pick<ChangeRouting, 'route' | 'overLimit' | 'noBoard' | 'costLimit' | 'scheduleLimitDays'>) {
  return {
    route: routing.route,
    overLimit: routing.overLimit,
    costLimit: routing.costLimit,
    scheduleLimitDays: routing.scheduleLimitDays,
    noBoard: routing.noBoard,
  };
}
