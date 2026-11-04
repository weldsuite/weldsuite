/**
 * Approvals core: the one table behind "My reviews" (design:
 * weldflow-delivery-and-portfolio.md; ADR FLOW-016).
 *
 * Everything that waits for someone's yes (change requests, stage gates,
 * deliverable sign-off, proposed decisions, accepting a risk, closing a
 * project, new project requests) inserts `flow_approvals` rows through
 * `requestApprovals`. Each row is one approver's answer. The table stores the
 * answers and does not decide anything: each subject type registers a handler
 * (`registerApprovalSubject`) that says whether its rows add up to approved,
 * rejected or still waiting, and what to do once they do.
 *
 * Routing (who is asked) stays with the subject, in its own function: the
 * change-request routing is FLOW-013's, the gate's is the sponsor plus a board
 * member, and so on. This file only holds what is the same for every subject:
 * the request, the answer, the delegation, the steps and the inbox query.
 *
 * Two layers, so the Rust flow-domain can mirror it one to one:
 *
 *   1. Pure functions and constants (no database, no clock): validation, step
 *      order, the default resolution, delegation choice, the review buckets.
 *      Every message returned here is sent to the client as it is, so both
 *      backends answer alike.
 *   2. Database functions, which take `now` (default: the clock). The id
 *      generator is their only other source of non-determinism.
 *
 * Answering is a right of the row, never of a workspace permission: the named
 * approver, or a member who is their active delegate. Callers check project
 * access and permissions for the routes around it.
 */

import { and, asc, eq, gt, inArray, isNull, lte, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  APPROVAL_DECISIONS,
  APPROVAL_SUBJECT_TYPES,
  APPROVER_KINDS,
  type ApprovalDecision,
  type ApprovalRule,
  type ApprovalSubjectType,
  type ApproverKind,
  type FlowApproval,
  type FlowApprovalDelegation,
} from '@weldsuite/db/schema/project-delivery';
import type { ProjectSettings } from '@weldsuite/db/schema/project-settings';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { compareText } from './compare';

export {
  APPROVAL_DECISIONS,
  APPROVAL_SUBJECT_TYPES,
  APPROVER_KINDS,
  type ApprovalDecision,
  type ApprovalRule,
  type ApprovalSubjectType,
  type ApproverKind,
};

export type ApprovalRow = FlowApproval;
export type ApprovalDelegationRow = FlowApprovalDelegation;

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** The answers that settle a row for good. */
export const FINAL_DECISIONS = ['approved', 'approved_with_conditions', 'rejected'] as const;

/** The answers a row can still be given: not answered yet, or the approver asked for more information. */
export const OPEN_DECISIONS = ['pending', 'info_requested'] as const;

/** Answers that count as a yes. */
export const APPROVING_DECISIONS = ['approved', 'approved_with_conditions'] as const;

/** Answers that need a note: a decline says why, conditions say which. */
export const NOTE_REQUIRED_DECISIONS = ['rejected', 'approved_with_conditions'] as const;

/**
 * The rule codes the routing functions use (`flow_approvals.rule.code`). A
 * subject may use more; this is the catalogue My reviews knows how to explain.
 *
 *   change_manager          a change under both limits: the project manager (FLOW-013)
 *   change_board_over_limit a change over a limit: every change board member
 *   gate                    a stage gate: the sponsor, and one change board member
 *   deliverable_sponsor     deliverable sign-off, first step: the sponsor
 *   deliverable_client      deliverable sign-off, second step: the client contact
 *   decision                a proposed decision: the named decider
 *   risk_acceptance         accepting a risk scoring 9 or more: the sponsor
 *   project_request         an intake request: every portfolio board member
 *   close                   closing a project: the sponsor
 */
export const APPROVAL_RULE_CODES = [
  'change_manager',
  'change_board_over_limit',
  'gate',
  'deliverable_sponsor',
  'deliverable_client',
  'decision',
  'risk_acceptance',
  'project_request',
  'close',
] as const;
export type ApprovalRuleCode = (typeof APPROVAL_RULE_CODES)[number];

/** What a subject's rows add up to. */
export type ApprovalOutcome = 'approved' | 'rejected' | 'pending';
export type ResolvedApprovalOutcome = Exclude<ApprovalOutcome, 'pending'>;

/** Who answers: a member (user id) or a CRM contact on the client portal. */
export interface ApprovalActor {
  kind: ApproverKind;
  id: string;
}

/** My reviews groups a list as overdue, this week and later. */
export type ReviewBucket = 'overdue' | 'this_week' | 'later';

/** The messages of every refusal, sent to the client as they are. */
export const APPROVAL_MESSAGES = {
  notFound: 'Approval not found',
  notApprover: 'You are not an approver of this review',
  alreadyDecided: 'This review has already been answered',
  stepNotActive: 'This review is waiting for an earlier step to be answered',
  invalidDecision: 'Choose approve, approve with conditions, decline or ask for more information',
  noteRequired: 'A note is required to decline or to set conditions',
  noApprovers: 'At least one approver is required',
  invalidSubject: 'Unknown approval subject type',
  invalidApprover: 'Every approver needs a kind and an id',
  invalidStep: 'A step is a whole number of 1 or more',
  invalidRule: 'Every approval needs the rule that selected the approver',
  alreadyRequested: 'Approvals have already been requested for this subject',
} as const;

// ── Pure rules ──────────────────────────────────────────────────────────────

/** The fields of a row the pure rules read; a full `ApprovalRow` satisfies it. */
export type ApprovalRowLike = Pick<ApprovalRow, 'decision' | 'step'> & { deletedAt?: Date | null };

export function isFinalDecision(decision: string): boolean {
  return (FINAL_DECISIONS as readonly string[]).includes(decision);
}

export function isOpenDecision(decision: string): boolean {
  return (OPEN_DECISIONS as readonly string[]).includes(decision);
}

function isApproving(decision: string): boolean {
  return (APPROVING_DECISIONS as readonly string[]).includes(decision);
}

/**
 * The refusal for the answer itself, or null: it has to be one of the four
 * answers (not `pending`), and declining or setting conditions needs a note.
 */
export function decisionInputError(input: { decision: string; note?: string | null }): string | null {
  const answers: readonly string[] = [...FINAL_DECISIONS, 'info_requested'];
  if (!answers.includes(input.decision)) return APPROVAL_MESSAGES.invalidDecision;
  if (
    (NOTE_REQUIRED_DECISIONS as readonly string[]).includes(input.decision) &&
    (input.note ?? '').trim().length === 0
  ) {
    return APPROVAL_MESSAGES.noteRequired;
  }
  return null;
}

/**
 * The default resolution, for the change board (every member has to approve)
 * and for ordered sign-off alike: one rejection rejects the subject, every row
 * approved (with or without conditions) approves it, anything else is still
 * waiting. Deleted rows are ignored; no rows is waiting.
 */
export function resolveUnanimous(rows: readonly ApprovalRowLike[]): ApprovalOutcome {
  const live = rows.filter((row) => !row.deletedAt);
  if (live.length === 0) return 'pending';
  if (live.some((row) => row.decision === 'rejected')) return 'rejected';
  if (live.every((row) => isApproving(row.decision))) return 'approved';
  return 'pending';
}

/**
 * Is this row's turn? A later step waits for the earlier one: it can be
 * answered only when every row of a lower step has been approved. Rows of the
 * same step run in parallel.
 */
export function isStepActive(row: Pick<ApprovalRowLike, 'step'>, siblings: readonly ApprovalRowLike[]): boolean {
  return siblings.every((other) => other.deletedAt || other.step >= row.step || isApproving(other.decision));
}

/**
 * The delegation in force for a member at `now`, or null: it starts at
 * `starts_at` (inclusive) and ends at `ends_at` (exclusive). When several
 * overlap, the one that started last wins, then the lowest id, so every
 * backend picks the same.
 */
export function activeDelegation<T extends Pick<ApprovalDelegationRow, 'id' | 'memberId' | 'startsAt' | 'endsAt'> & { deletedAt?: Date | null }>(
  delegations: readonly T[],
  memberId: string,
  now: Date,
): T | null {
  const active = delegations.filter(
    (row) => !row.deletedAt && row.memberId === memberId && row.startsAt <= now && now < row.endsAt,
  );
  active.sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime() || compareText(a.id, b.id));
  return active[0] ?? null;
}

/** The last instant (UTC) of the ISO week (Monday to Sunday) that holds `now`. */
export function endOfIsoWeek(now: Date): Date {
  const day = now.getUTCDay(); // 0 = Sunday
  const daysToSunday = (7 - day) % 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToSunday, 23, 59, 59, 999));
}

/** The My reviews group of a row: past due is overdue, due by Sunday is this week, the rest (and no due date) is later. */
export function reviewBucket(dueAt: Date | null | undefined, now: Date): ReviewBucket {
  if (!dueAt) return 'later';
  if (dueAt < now) return 'overdue';
  return dueAt <= endOfIsoWeek(now) ? 'this_week' : 'later';
}

/** The order of My reviews: earliest due date first (no date last), then oldest request, then id. */
export function compareReviews(
  a: Pick<ApprovalRow, 'id' | 'dueAt' | 'createdAt'>,
  b: Pick<ApprovalRow, 'id' | 'dueAt' | 'createdAt'>,
): number {
  const aDue = a.dueAt ? a.dueAt.getTime() : Number.POSITIVE_INFINITY;
  const bDue = b.dueAt ? b.dueAt.getTime() : Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue < bDue ? -1 : 1;
  const created = a.createdAt.getTime() - b.createdAt.getTime();
  if (created !== 0) return created;
  return compareText(a.id, b.id);
}

/**
 * The project's sponsor: `settings.sponsorId`, else the project manager. Several
 * rules route to the sponsor (gates, sign-off, risk acceptance, closing).
 */
export function sponsorOf(
  settings: Pick<ProjectSettings, 'sponsorId'> | null | undefined,
  projectManagerId: string | null | undefined,
): string | null {
  return settings?.sponsorId || projectManagerId || null;
}

/** One approver of a request: who, in which step, and the rule that selected them. */
export interface ApprovalRowInput {
  /** Default `member`. */
  approverKind?: ApproverKind;
  approverId: string;
  roleLabel?: string | null;
  /** 1-based, default 1. Same step = in parallel. */
  step?: number;
  rule: ApprovalRule;
  dueAt?: Date | null;
}

export interface RequestApprovalsInput {
  /** Null for a project request (it is not a project yet). */
  projectId: string | null;
  subjectType: ApprovalSubjectType;
  subjectId: string;
  /** Who asked: told when a review is overdue. */
  requestedBy: string;
  rows: readonly ApprovalRowInput[];
  /** Defaults to the clock. */
  now?: Date;
}

/** The refusal for a request, or null. */
export function approvalRequestError(input: Pick<RequestApprovalsInput, 'subjectType' | 'rows'>): string | null {
  if (!(APPROVAL_SUBJECT_TYPES as readonly string[]).includes(input.subjectType)) return APPROVAL_MESSAGES.invalidSubject;
  if (input.rows.length === 0) return APPROVAL_MESSAGES.noApprovers;
  for (const row of input.rows) {
    const kind = row.approverKind ?? 'member';
    if (!(APPROVER_KINDS as readonly string[]).includes(kind) || !row.approverId?.trim()) {
      return APPROVAL_MESSAGES.invalidApprover;
    }
    const step = row.step ?? 1;
    if (!Number.isInteger(step) || step < 1) return APPROVAL_MESSAGES.invalidStep;
    if (!row.rule?.code?.trim()) return APPROVAL_MESSAGES.invalidRule;
  }
  return null;
}

/** An approver once the delegation is applied: who is asked now, and for whom. */
export interface PlannedApprover {
  approverKind: ApproverKind;
  approverId: string;
  delegatedFrom: string | null;
  roleLabel: string | null;
  step: number;
  rule: ApprovalRule;
  dueAt: Date | null;
}

/**
 * The approvers a request creates rows for: a member on delegation is replaced
 * by their delegate (`delegatedFrom` keeps the member), and a person asked
 * twice for one subject, directly or through delegation, is asked once, in the
 * lowest step. The order is by step, then as given.
 */
export function planApprovers(
  rows: readonly ApprovalRowInput[],
  delegations: readonly Pick<ApprovalDelegationRow, 'id' | 'memberId' | 'delegateId' | 'startsAt' | 'endsAt'>[],
  now: Date,
): PlannedApprover[] {
  const planned: PlannedApprover[] = [];
  for (const row of rows) {
    const approverKind = row.approverKind ?? 'member';
    let approverId = row.approverId.trim();
    let delegatedFrom: string | null = null;
    if (approverKind === 'member') {
      const delegation = activeDelegation(delegations, approverId, now);
      if (delegation) {
        delegatedFrom = approverId;
        approverId = delegation.delegateId;
      }
    }
    planned.push({
      approverKind,
      approverId,
      delegatedFrom,
      roleLabel: row.roleLabel ?? null,
      step: row.step ?? 1,
      rule: row.rule,
      dueAt: row.dueAt ?? null,
    });
  }
  const ordered = planned
    .map((p, index) => ({ p, index }))
    .sort((a, b) => a.p.step - b.p.step || a.index - b.index)
    .map(({ p }) => p);
  const seen = new Set<string>();
  return ordered.filter((p) => {
    const key = `${p.approverKind}:${p.approverId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Subject handlers ────────────────────────────────────────────────────────

/** What a handler gets when its subject is settled. */
export interface ApprovalResolutionContext {
  /** The subject's live rows, in step order. */
  rows: ApprovalRow[];
  /** Who gave the answer that settled it (null when a sweep re-evaluates). */
  actor: ApprovalActor | null;
  now: Date;
}

/**
 * How one subject type reacts to its approvals. Slices register theirs where
 * they define the subject (`registerApprovalSubject('change_request', ...)` at
 * the top of their service file, which their router imports, so every flow-api
 * isolate registers all of them).
 */
export interface ApprovalSubjectHandler {
  /**
   * Whether the rows add up to approved, rejected or still waiting. Default
   * {@link resolveUnanimous}. Must be pure.
   */
  resolve?(rows: ApprovalRow[]): ApprovalOutcome;
  /**
   * Runs once the rows settle the subject: apply the change, pass the gate,
   * mark the deliverable accepted. Runs after the answer is stored and may run
   * again if the subject is re-evaluated ({@link resolveApprovalSubject}), so
   * it has to be idempotent.
   */
  onResolved(
    db: Database,
    subjectId: string,
    outcome: ResolvedApprovalOutcome,
    context: ApprovalResolutionContext,
  ): Promise<void> | void;
}

const subjectHandlers = new Map<ApprovalSubjectType, ApprovalSubjectHandler>();

/** Plug in a subject type. A type has one handler: registering it twice throws, so two slices can't both claim it. */
export function registerApprovalSubject(type: ApprovalSubjectType, handler: ApprovalSubjectHandler): void {
  if (subjectHandlers.has(type)) throw new Error(`An approval handler is already registered for "${type}"`);
  subjectHandlers.set(type, handler);
}

/** Remove a handler (tests, hot reload). */
export function unregisterApprovalSubject(type: ApprovalSubjectType): void {
  subjectHandlers.delete(type);
}

export function getApprovalSubjectHandler(type: ApprovalSubjectType): ApprovalSubjectHandler | undefined {
  return subjectHandlers.get(type);
}

/** The outcome of a subject's rows under its handler (default: unanimous). */
export function resolveSubjectRows(type: ApprovalSubjectType, rows: ApprovalRow[]): ApprovalOutcome {
  const handler = subjectHandlers.get(type);
  return handler?.resolve ? handler.resolve(rows) : resolveUnanimous(rows);
}

// ── Database ────────────────────────────────────────────────────────────────

const t = schema.flowApprovals;
const dlg = schema.flowApprovalDelegations;

/** A subject's live rows, in step order. */
export async function listSubjectApprovals(
  db: Database,
  subjectType: ApprovalSubjectType,
  subjectId: string,
): Promise<ApprovalRow[]> {
  return db
    .select()
    .from(t)
    .where(and(eq(t.subjectType, subjectType), eq(t.subjectId, subjectId), isNull(t.deletedAt)))
    .orderBy(asc(t.step), asc(t.createdAt), asc(t.id));
}

/** The delegation in force for a member right now, or null. */
export async function findActiveDelegation(
  db: Database,
  memberId: string,
  now: Date = new Date(),
): Promise<ApprovalDelegationRow | null> {
  const rows = await db
    .select()
    .from(dlg)
    .where(and(eq(dlg.memberId, memberId), isNull(dlg.deletedAt), lte(dlg.startsAt, now), gt(dlg.endsAt, now)));
  return activeDelegation(rows, memberId, now);
}

/** The members who have delegated their reviews to this person right now. */
export async function listActiveDelegators(db: Database, delegateId: string, now: Date = new Date()): Promise<string[]> {
  const rows = await db
    .select({ id: dlg.id, memberId: dlg.memberId, startsAt: dlg.startsAt, endsAt: dlg.endsAt })
    .from(dlg)
    .where(and(eq(dlg.delegateId, delegateId), isNull(dlg.deletedAt), lte(dlg.startsAt, now), gt(dlg.endsAt, now)));
  return [...new Set(rows.map((row) => row.memberId))].sort();
}

export type RequestApprovalsResult =
  | { ok: true; rows: ApprovalRow[] }
  | { ok: false; code: 'invalid' | 'already_requested'; message: string };

/**
 * Ask for approvals: one row per approver, in one insert. A member on
 * delegation is replaced by their delegate (the row keeps `delegated_from`).
 * Refuses a subject that still has live rows; clear them first with
 * {@link cancelPendingApprovals} (a change edited after submission is routed
 * again from scratch, FLOW-013). Entity events are the caller's.
 */
export async function requestApprovals(db: Database, input: RequestApprovalsInput): Promise<RequestApprovalsResult> {
  const invalid = approvalRequestError(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };

  const existing = await listSubjectApprovals(db, input.subjectType, input.subjectId);
  if (existing.length > 0) {
    return { ok: false, code: 'already_requested', message: APPROVAL_MESSAGES.alreadyRequested };
  }

  const now = input.now ?? new Date();
  const memberIds = [
    ...new Set(input.rows.filter((row) => (row.approverKind ?? 'member') === 'member').map((row) => row.approverId.trim())),
  ];
  const delegations =
    memberIds.length === 0
      ? []
      : await db
          .select()
          .from(dlg)
          .where(and(inArray(dlg.memberId, memberIds), isNull(dlg.deletedAt), lte(dlg.startsAt, now), gt(dlg.endsAt, now)));

  const planned = planApprovers(input.rows, delegations, now);
  const inserted = await db
    .insert(t)
    .values(
      planned.map((p, index) => ({
        id: generateId('apr'),
        projectId: input.projectId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        approverKind: p.approverKind,
        approverId: p.approverId,
        roleLabel: p.roleLabel,
        step: p.step,
        rule: p.rule,
        decision: 'pending' as const,
        dueAt: p.dueAt,
        delegatedFrom: p.delegatedFrom,
        createdBy: input.requestedBy,
        // One millisecond apart, so a subject's rows list in the order they were planned.
        createdAt: new Date(now.getTime() + index),
        updatedAt: now,
      })),
    )
    .returning();
  return { ok: true, rows: inserted.sort((a, b) => a.step - b.step) };
}

export interface DecideApprovalInput {
  approvalId: string;
  /** A member's user id, or `{ kind, id }` (a portal contact answers as `{ kind: 'contact', id }`). */
  actor: string | ApprovalActor;
  decision: ApprovalDecision;
  note?: string | null;
  /** Defaults to the clock. */
  now?: Date;
}

export type DecideApprovalError =
  | 'not_found'
  | 'not_approver'
  | 'already_decided'
  | 'step_not_active'
  | 'invalid_decision'
  | 'note_required';

export type DecideApprovalResult =
  | {
      ok: true;
      /** The row as answered. */
      approval: ApprovalRow;
      /** What the subject's rows add up to now. */
      outcome: ApprovalOutcome;
      /** True when this answer settled the subject (its handler ran). */
      resolved: boolean;
      /** The subject's live rows after the answer. */
      rows: ApprovalRow[];
      /** True when a delegate answered for the approver. */
      viaDelegation: boolean;
    }
  | { ok: false; code: DecideApprovalError; message: string };

function asActor(actor: string | ApprovalActor): ApprovalActor {
  return typeof actor === 'string' ? { kind: 'member', id: actor } : actor;
}

/** How the actor stands to a row: its named approver, their active delegate, or neither. */
async function standingOf(
  db: Database,
  row: ApprovalRow,
  actor: ApprovalActor,
  now: Date,
): Promise<'approver' | 'delegate' | null> {
  // A member row stored for a delegate (`delegatedFrom` = the member) stays the member's to answer
  // too, so it does not strand when the delegation ends.
  const named = row.approverId === actor.id || (actor.kind === 'member' && row.delegatedFrom === actor.id);
  if (row.approverKind === actor.kind && named) return 'approver';
  if (actor.kind !== 'member' || row.approverKind !== 'member') return null;
  const delegation = await findActiveDelegation(db, row.approverId, now);
  return delegation?.delegateId === actor.id ? 'delegate' : null;
}

/**
 * Answer a review. The checks run in a fixed order, so every backend answers
 * alike: the row exists, the actor is its approver or their active delegate,
 * it is still open, it is its step's turn, then the answer itself (one of the
 * four, a note for a decline or conditions).
 *
 * The answer is stored with a guarded update (only an open row changes), so
 * two answers at once cannot both win. Then the subject's handler decides
 * whether the rows settle it; if they do, a rejection clears the other open
 * rows (nobody is asked about a settled subject) and `onResolved` runs. If
 * `onResolved` throws, the answer stays stored and the error propagates:
 * {@link resolveApprovalSubject} runs the resolution again.
 */
export async function decideApproval(db: Database, input: DecideApprovalInput): Promise<DecideApprovalResult> {
  const now = input.now ?? new Date();
  const actor = asActor(input.actor);
  const fail = (code: DecideApprovalError, message: string): DecideApprovalResult => ({ ok: false, code, message });

  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.id, input.approvalId), isNull(t.deletedAt)))
    .limit(1);
  if (!row) return fail('not_found', APPROVAL_MESSAGES.notFound);

  const standing = await standingOf(db, row, actor, now);
  if (!standing) return fail('not_approver', APPROVAL_MESSAGES.notApprover);
  const viaDelegation = standing === 'delegate';

  if (!isOpenDecision(row.decision)) return fail('already_decided', APPROVAL_MESSAGES.alreadyDecided);

  const siblings = await listSubjectApprovals(db, row.subjectType, row.subjectId);
  if (!isStepActive(row, siblings)) return fail('step_not_active', APPROVAL_MESSAGES.stepNotActive);

  const inputError = decisionInputError({ decision: input.decision, note: input.note });
  if (inputError) {
    return fail(
      (NOTE_REQUIRED_DECISIONS as readonly string[]).includes(input.decision) ? 'note_required' : 'invalid_decision',
      inputError,
    );
  }

  const note = input.note?.trim() ? input.note.trim() : null;
  const [updated] = await db
    .update(t)
    .set({ decision: input.decision, note, decidedAt: now, decidedBy: actor.id, updatedAt: now })
    .where(and(eq(t.id, row.id), isNull(t.deletedAt), inArray(t.decision, [...OPEN_DECISIONS])))
    .returning();
  // Someone answered between the read and the update.
  if (!updated) return fail('already_decided', APPROVAL_MESSAGES.alreadyDecided);

  const result = await resolveApprovalSubject(db, row.subjectType, row.subjectId, { actor, now });
  const rows = result.rows;
  return {
    ok: true,
    approval: rows.find((r) => r.id === updated.id) ?? updated,
    outcome: result.outcome,
    resolved: result.resolved,
    rows,
    viaDelegation,
  };
}

/**
 * Evaluate a subject's rows under its handler and, when they settle it, clear
 * the other open rows of a rejected subject and run `onResolved`. Used after
 * every answer, and to run the resolution again when it failed halfway
 * (`onResolved` is idempotent).
 */
export async function resolveApprovalSubject(
  db: Database,
  subjectType: ApprovalSubjectType,
  subjectId: string,
  options: { actor?: ApprovalActor | null; now?: Date } = {},
): Promise<{ outcome: ApprovalOutcome; resolved: boolean; rows: ApprovalRow[] }> {
  const now = options.now ?? new Date();
  let rows = await listSubjectApprovals(db, subjectType, subjectId);
  const outcome = resolveSubjectRows(subjectType, rows);
  if (outcome === 'pending') return { outcome, resolved: false, rows };

  if (outcome === 'rejected' && rows.some((row) => isOpenDecision(row.decision))) {
    await cancelPendingApprovals(db, { subjectType, subjectId, now });
    rows = await listSubjectApprovals(db, subjectType, subjectId);
  }
  await subjectHandlers.get(subjectType)?.onResolved(db, subjectId, outcome, { rows, actor: options.actor ?? null, now });
  return { outcome, resolved: true, rows };
}

/**
 * Clear a subject's open rows (soft delete): a withdrawn request, a rejected
 * subject's other approvers, a change sent back to assessing. Answered rows
 * stay unless `includeDecided` is set, which a re-routed change uses to start
 * its approvals over (FLOW-013). Returns the rows it cleared.
 */
export async function cancelPendingApprovals(
  db: Database,
  input: { subjectType: ApprovalSubjectType; subjectId: string; includeDecided?: boolean; now?: Date },
): Promise<ApprovalRow[]> {
  const now = input.now ?? new Date();
  const conditions: SQL[] = [eq(t.subjectType, input.subjectType), eq(t.subjectId, input.subjectId), isNull(t.deletedAt)];
  if (!input.includeDecided) conditions.push(inArray(t.decision, [...OPEN_DECISIONS]));
  return db
    .update(t)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(...conditions))
    .returning();
}

/** A row of one of these projects, or without a project (a project request has none yet). */
export function inAccessibleOrNoProject(projectId: AnyColumn, accessible: readonly string[]): SQL {
  return accessible.length > 0
    ? (or(isNull(projectId), inArray(projectId, [...accessible])) as SQL)
    : isNull(projectId);
}

export interface PendingReviewFilters {
  subjectTypes?: readonly ApprovalSubjectType[];
  projectId?: string;
  /** `member` (default), or `contact` for the client portal. */
  approverKind?: ApproverKind;
  /** Which answers to list. Default: `pending` only (a review waiting for more information is not waiting for this person). */
  decisions?: readonly ApprovalDecision[];
  /** Also list the reviews of members who delegated to this person. Default true. */
  includeDelegated?: boolean;
  /** Also list rows whose earlier steps are not answered yet. Default false. */
  includeWaiting?: boolean;
  /**
   * The projects the caller may see (`accessibleProjectIds`): rows of other projects are left out,
   * rows without a project stay. `null` or undefined: no limit.
   */
  accessibleProjectIds?: readonly string[] | null;
  /** Default 200, at most 500. */
  limit?: number;
  /** Defaults to the clock. */
  now?: Date;
}

export interface PendingReview {
  approval: ApprovalRow;
  /** The row is a delegator's, shown because this person is their active delegate. */
  viaDelegation: boolean;
  /** Its earlier steps are answered, so it can be answered now. */
  actionable: boolean;
  bucket: ReviewBucket;
}

/**
 * The inbox: this person's open reviews across every subject type (and, for a
 * member, those of members who delegated to them), earliest due date first.
 * Reads the (`approver_id`, `decision`, `due_at`) index. Rows that wait for an
 * earlier step are left out unless asked for.
 */
export async function listPendingForApprover(
  db: Database,
  userId: string,
  filters: PendingReviewFilters = {},
): Promise<PendingReview[]> {
  const now = filters.now ?? new Date();
  const kind = filters.approverKind ?? 'member';
  const delegators =
    kind === 'member' && filters.includeDelegated !== false ? await listActiveDelegators(db, userId, now) : [];
  const approverIds = [userId, ...delegators.filter((id) => id !== userId)];
  const decisions: ApprovalDecision[] = filters.decisions ? [...filters.decisions] : ['pending'];

  // A member also keeps the rows asked of a delegate while they were away (`delegatedFrom`).
  const mine = kind === 'member' ? or(inArray(t.approverId, approverIds), eq(t.delegatedFrom, userId)) : inArray(t.approverId, approverIds);
  const conditions: SQL[] = [eq(t.approverKind, kind), mine as SQL, inArray(t.decision, decisions), isNull(t.deletedAt)];
  if (filters.accessibleProjectIds) conditions.push(inAccessibleOrNoProject(t.projectId, filters.accessibleProjectIds));
  if (filters.subjectTypes && filters.subjectTypes.length > 0) conditions.push(inArray(t.subjectType, [...filters.subjectTypes]));
  if (filters.projectId) conditions.push(eq(t.projectId, filters.projectId));

  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const rows = await db
    .select()
    .from(t)
    .where(and(...conditions))
    .orderBy(sql`${t.dueAt} asc nulls last`, asc(t.createdAt), asc(t.id))
    .limit(limit);
  if (rows.length === 0) return [];

  // A later step waits for the earlier one: read the siblings of these subjects.
  const siblingsByKey = new Map<string, ApprovalRow[]>();
  const subjectIds = [...new Set(rows.map((row) => row.subjectId))];
  const siblings = await db
    .select()
    .from(t)
    .where(and(inArray(t.subjectId, subjectIds), isNull(t.deletedAt)));
  for (const sibling of siblings) {
    const key = `${sibling.subjectType}:${sibling.subjectId}`;
    const list = siblingsByKey.get(key);
    if (list) list.push(sibling);
    else siblingsByKey.set(key, [sibling]);
  }

  const reviews: PendingReview[] = rows.map((approval) => ({
    approval,
    viaDelegation: approval.approverId !== userId && approval.delegatedFrom !== userId,
    actionable: isStepActive(approval, siblingsByKey.get(`${approval.subjectType}:${approval.subjectId}`) ?? [approval]),
    bucket: reviewBucket(approval.dueAt, now),
  }));
  return reviews
    .filter((review) => filters.includeWaiting || review.actionable)
    .sort((a, b) => compareReviews(a.approval, b.approval));
}
