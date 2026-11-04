/**
 * Approvals (FLOW-016) for flow-api: what My reviews, "Sent by me" and "Done"
 * show, the notifications and entity events that go with asking for and
 * answering a review, and the hook a subject uses to publish its own events
 * once its approvals settle it.
 *
 * The rules (who may answer, steps, delegation, resolution) are in
 * `@weldsuite/flow-domain/approvals`; this file is the database side of the
 * routes in `routes/approvals`.
 *
 * # For the slices that own a subject type
 *
 * After `requestApprovals`, call {@link announceApprovalsRequested} with the
 * rows: it publishes `flow_approval.requested`, notifies the approvers who can
 * answer now and marks the workspace for the `approval_due` reminders. After
 * `cancelPendingApprovals`, call {@link announceApprovalsCancelled}. Your
 * handler's `onResolved` has no request context, so to publish your own events
 * when `POST /api/approvals/:id/decide` settles the subject, register an
 * aftermath with {@link registerApprovalAftermath}.
 */

import type { Context } from 'hono';
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { createAndDeliverNotification } from '@weldsuite/notifications';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type {
  ApprovalSubjectType,
  MyReviews,
  ReviewItem,
  ReviewType,
  SentReview,
} from '@weldsuite/app-api-client/schemas/flow-approvals';
import {
  decideApproval,
  isStepActive,
  listSubjectApprovals,
  listPendingForApprover,
  resolveSubjectRows,
  reviewBucket,
  type ApprovalActor,
  type ApprovalDecision,
  type DecideApprovalResult,
  type ApprovalOutcome,
  type ApprovalRow,
} from '@weldsuite/flow-domain/approvals';
import {
  approvalEventData,
  hoursOfMinutes,
  presentReviewApprover,
  reviewImpacts,
  summarize,
  type ReviewImpact,
  type ReviewLink,
} from '@weldsuite/flow-domain/approval-views';
import { changeCode, deliverableCode } from '@weldsuite/flow-domain/changes';
import { raidCode } from '@weldsuite/flow-domain/raid';
import type { Env, Variables } from '../types';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const approvals = schema.flowApprovals;
const DAY_MS = 86_400_000;

// ── Events and notifications ────────────────────────────────────────────────

type ApprovalAction = 'requested' | 'decided' | 'delegated' | 'overdue' | 'cancelled';

/** One `flow_approval` entity event for a row. */
export function publishApproval(c: AppContext, action: ApprovalAction, row: ApprovalRow, extra: Record<string, unknown> = {}): void {
  publishEntityEvent({
    c,
    entityType: 'flow_approval',
    entityId: row.id,
    action,
    data: { ...approvalEventData(row), ...extra },
  });
}

/** What a notification says the review is about. */
export interface ApprovalSubjectLabel {
  code: string | null;
  title: string;
}

function labelText(label: ApprovalSubjectLabel): string {
  const text = label.code ? `${label.code} ${label.title}` : label.title;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

interface NotifyBase {
  db: Database;
  env: Env;
  /** Clerk org id (the realtime hub and the email links use it). */
  clerkOrgId: string;
}

/** Tell a member a review waits for them, or that one they asked for is late. Best effort: a failure is logged, never thrown. */
export async function sendApprovalNotification(
  base: NotifyBase,
  input: {
    userId: string;
    approvalId: string;
    kind: 'requested' | 'reminder' | 'overdue';
    label: ApprovalSubjectLabel;
    actorId?: string | null;
    projectName?: string | null;
  },
): Promise<void> {
  const text = labelText(input.label);
  const where = input.projectName ? ` in ${input.projectName}` : '';
  const copy = {
    requested: { title: `Review requested: ${text}`, body: `Your review is needed on ${text}${where}.`, severity: 'info' as const },
    reminder: { title: `Review due tomorrow: ${text}`, body: `${text}${where} is due for your review tomorrow.`, severity: 'warning' as const },
    overdue: { title: `Review overdue: ${text}`, body: `${text}${where} is still waiting for a review.`, severity: 'warning' as const },
  }[input.kind];
  try {
    await createAndDeliverNotification({
      db: base.db as never,
      env: base.env,
      workspaceId: base.clerkOrgId,
      clerkOrgId: base.clerkOrgId,
      userId: input.userId,
      title: copy.title.slice(0, 255),
      body: copy.body,
      category: 'projects',
      notificationType: 'project_updated',
      entityType: 'flow_approval',
      entityId: input.approvalId,
      actionUrl: '/weldflow/reviews',
      severity: copy.severity,
      actorType: input.actorId ? 'user' : 'system',
      actorId: input.actorId ?? null,
    });
  } catch (err) {
    console.error('[flow-api/approvals] notification failed:', err);
  }
}

/** When a row's reminder is due: a day before the review is. */
export function reminderDueAt(dueAt: Date): Date {
  return new Date(dueAt.getTime() - DAY_MS);
}

/** Notify the member approvers of `rows` (never the requester) with `kind`, in the background. */
function notifyApprovers(c: AppContext, rows: readonly ApprovalRow[], label: ApprovalSubjectLabel, projectName: string | null | undefined): void {
  const userId = c.get('userId');
  const base: NotifyBase = { db: c.get('tenantDb'), env: c.env, clerkOrgId: c.get('clerkOrgId') };
  for (const row of rows) {
    if (row.approverKind !== 'member' || row.approverId === userId) continue;
    c.executionCtx.waitUntil(
      sendApprovalNotification(base, { userId: row.approverId, approvalId: row.id, kind: 'requested', label, actorId: userId, projectName }),
    );
  }
}

/**
 * Call this after `requestApprovals`: publishes `flow_approval.requested` for
 * each row, notifies the approvers who can answer now (the lowest step; a later
 * step is told when its turn comes) and marks the workspace for the
 * `approval_due` reminders. The requester is never notified about their own
 * request.
 */
export function announceApprovalsRequested(
  c: AppContext,
  input: { rows: readonly ApprovalRow[]; subject: ApprovalSubjectLabel; projectName?: string | null },
): void {
  for (const row of input.rows) publishApproval(c, 'requested', row);
  const firstStep = Math.min(...input.rows.map((row) => row.step));
  notifyApprovers(
    c,
    input.rows.filter((row) => row.step === firstStep),
    input.subject,
    input.projectName,
  );
  markReminderDue(c, input.rows);
}

/** Mark the workspace for the `approval_due` sweep at the earliest reminder of `rows`. Best effort. */
export function markReminderDue(c: AppContext, rows: readonly ApprovalRow[]): void {
  const dues = rows.filter((row) => row.dueAt).map((row) => reminderDueAt(row.dueAt as Date).getTime());
  if (dues.length === 0 || !c.env.SCHEDULE_INDEX) return;
  c.executionCtx.waitUntil(markWorkspaceDue(c.env.SCHEDULE_INDEX, 'approval_due', c.get('clerkOrgId'), Math.min(...dues)));
}

/** Call this after `cancelPendingApprovals`: publishes `flow_approval.cancelled` for each cleared row. */
export function announceApprovalsCancelled(c: AppContext, rows: readonly ApprovalRow[]): void {
  for (const row of rows) publishApproval(c, 'cancelled', row);
}

/** Tell the approvers whose step has just come up (after an earlier step approved). */
export function announceStepsActivated(
  c: AppContext,
  before: readonly ApprovalRow[],
  after: readonly ApprovalRow[],
  label: ApprovalSubjectLabel,
  projectName: string | null | undefined,
): void {
  const newlyActive = after.filter(
    (row) => row.decision === 'pending' && isStepActive(row, after) && !isStepActive(row, before),
  );
  if (newlyActive.length > 0) notifyApprovers(c, newlyActive, label, projectName);
}

// ── Aftermath hooks ─────────────────────────────────────────────────────────

/** What an aftermath hook is told when `POST /api/approvals/:id/decide` settled a subject. */
export interface ApprovalAftermathInfo {
  subjectId: string;
  projectId: string | null;
  outcome: 'approved' | 'rejected';
  /** The subject's live rows after the answer. */
  rows: ApprovalRow[];
  /** The answer that settled it. */
  decided: ApprovalRow;
  actor: ApprovalActor;
}

export type ApprovalAftermath = (c: AppContext, info: ApprovalAftermathInfo) => Promise<void> | void;

const aftermaths = new Map<ApprovalSubjectType, ApprovalAftermath>();

/**
 * Publish a subject's own entity events (and anything else that needs the
 * request) once an answer settles it. `onResolved` of the subject's handler has
 * already run when this does. One hook per type; registering it twice throws.
 */
export function registerApprovalAftermath(type: ApprovalSubjectType, hook: ApprovalAftermath): void {
  if (aftermaths.has(type)) throw new Error(`An approval aftermath is already registered for "${type}"`);
  aftermaths.set(type, hook);
}

/** Run the aftermath of a subject type, if it has one. A failure is logged: the answer is already stored. */
export async function runApprovalAftermath(c: AppContext, type: ApprovalSubjectType, info: ApprovalAftermathInfo): Promise<void> {
  const hook = aftermaths.get(type);
  if (!hook) return;
  try {
    await hook(c, info);
  } catch (err) {
    console.error(`[flow-api/approvals] ${type} aftermath failed:`, err);
  }
}

/**
 * Answer a review and announce it: the one path behind
 * `POST /api/approvals/:id/decide` and the client portal's decide. Runs
 * `decideApproval`, publishes `flow_approval.decided`, clears the rows a
 * rejection leaves open (`cancelled`), then either runs the subject's
 * aftermath (the answer settled it) or tells the approvers whose step came up.
 * A refusal is returned untouched for the caller to map to a response.
 */
export async function decideAndAnnounce(
  c: AppContext,
  row: Pick<ApprovalRow, 'id' | 'subjectType' | 'subjectId' | 'projectId'>,
  input: { actor: string | ApprovalActor; decision: ApprovalDecision; note?: string | null },
): Promise<DecideApprovalResult> {
  const db = c.get('tenantDb');
  const before = await listSubjectApprovals(db, row.subjectType, row.subjectId);
  const result = await decideApproval(db, { approvalId: row.id, actor: input.actor, decision: input.decision, note: input.note, now: new Date() });
  if (!result.ok) return result;

  publishApproval(c, 'decided', result.approval, { outcome: result.outcome, resolved: result.resolved, viaDelegation: result.viaDelegation });
  // A rejection clears the other open rows: nobody is asked about a settled subject.
  announceApprovalsCancelled(
    c,
    before.filter((b) => !result.rows.some((r) => r.id === b.id)),
  );

  if (result.resolved) {
    await runApprovalAftermath(c, row.subjectType, {
      subjectId: row.subjectId,
      projectId: row.projectId,
      outcome: result.outcome as 'approved' | 'rejected',
      rows: result.rows,
      decided: result.approval,
      actor: typeof input.actor === 'string' ? { kind: 'member', id: input.actor } : input.actor,
    });
  } else if (input.decision === 'approved' || input.decision === 'approved_with_conditions') {
    // The next step's approvers are told when their turn comes.
    const info = (await loadSubjectInfo(db, [row])).get(`${row.subjectType}:${row.subjectId}`);
    announceStepsActivated(
      c,
      before.map((b) => (b.id === result.approval.id ? result.approval : b)),
      result.rows,
      { code: info?.code ?? null, title: info?.title ?? row.subjectId },
      null,
    );
  }
  return result;
}

// ── What a subject is ───────────────────────────────────────────────────────

/** The title, code and figures of one subject, as the reviewer sees them. */
export interface SubjectInfo {
  projectId: string | null;
  code: string | null;
  title: string;
  summary: string | null;
  impacts: ReviewImpact[];
  links: ReviewLink[];
}

const keyOf = (type: string, id: string) => `${type}:${id}`;

/** Look up the subjects the rows are about, by `type:id`. A subject that is gone is absent. */
export async function loadSubjectInfo(db: Database, rows: readonly Pick<ApprovalRow, 'subjectType' | 'subjectId'>[]): Promise<Map<string, SubjectInfo>> {
  const out = new Map<string, SubjectInfo>();
  const ids = (type: ApprovalSubjectType) => [...new Set(rows.filter((row) => row.subjectType === type).map((row) => row.subjectId))];

  const changeIds = ids('change_request');
  if (changeIds.length > 0) {
    const t = schema.projectChangeRequests;
    const found = await db
      .select({ row: t, currency: schema.projects.budgetCurrency })
      .from(t)
      .leftJoin(schema.projects, eq(schema.projects.id, t.projectId))
      .where(inArray(t.id, changeIds));
    const milestoneIds = new Set<string>();
    const deliverableIds = new Set<string>();
    for (const { row } of found) {
      for (const move of row.planChanges?.milestones ?? []) milestoneIds.add(move.milestoneId);
      for (const move of row.planChanges?.deliverables ?? []) deliverableIds.add(move.deliverableId);
      for (const id of row.scopeChanges?.remove ?? []) deliverableIds.add(id);
    }
    const [milestoneRows, deliverableRows] = await Promise.all([
      milestoneIds.size > 0
        ? db.select({ id: schema.milestones.id, name: schema.milestones.name }).from(schema.milestones).where(inArray(schema.milestones.id, [...milestoneIds]))
        : Promise.resolve([]),
      deliverableIds.size > 0
        ? db
            .select({ id: schema.projectDeliverables.id, number: schema.projectDeliverables.number, title: schema.projectDeliverables.title })
            .from(schema.projectDeliverables)
            .where(inArray(schema.projectDeliverables.id, [...deliverableIds]))
        : Promise.resolve([]),
    ]);
    const milestoneNames = new Map(milestoneRows.map((m) => [m.id, m.name]));
    const deliverables = new Map(deliverableRows.map((d) => [d.id, d]));
    for (const { row, currency } of found) {
      const links: ReviewLink[] = [];
      for (const move of row.planChanges?.milestones ?? []) {
        const name = milestoneNames.get(move.milestoneId);
        if (name) links.push({ type: 'milestone', id: move.milestoneId, title: name, code: null, relation: 'moves' });
      }
      for (const move of row.planChanges?.deliverables ?? []) {
        const d = deliverables.get(move.deliverableId);
        if (d) links.push({ type: 'deliverable', id: d.id, title: d.title, code: deliverableCode(d.number), relation: 'moves' });
      }
      for (const added of row.scopeChanges?.add ?? []) {
        if (added.deliverableId) links.push({ type: 'deliverable', id: added.deliverableId, title: added.title, code: null, relation: 'adds' });
      }
      for (const id of row.scopeChanges?.remove ?? []) {
        const d = deliverables.get(id);
        if (d) links.push({ type: 'deliverable', id: d.id, title: d.title, code: deliverableCode(d.number), relation: 'removes' });
      }
      out.set(keyOf('change_request', row.id), {
        projectId: row.projectId,
        code: changeCode(row.number),
        title: row.title,
        summary: summarize(row.description),
        impacts: reviewImpacts({ cost: row.costDelta, currency, scheduleDays: row.scheduleDeltaDays }),
        links,
      });
    }
  }

  const riskIds = ids('risk_acceptance');
  if (riskIds.length > 0) {
    const t = schema.projectRaidItems;
    const found = await db
      .select({ row: t, currency: schema.projects.budgetCurrency })
      .from(t)
      .leftJoin(schema.projects, eq(schema.projects.id, t.projectId))
      .where(inArray(t.id, riskIds));
    for (const { row, currency } of found) {
      const score = row.probability !== null && row.impact !== null ? row.probability * row.impact : null;
      out.set(keyOf('risk_acceptance', row.id), {
        projectId: row.projectId,
        code: raidCode(row.kind, row.number),
        title: row.title,
        summary: summarize(row.description),
        impacts: reviewImpacts({ riskScore: score, cost: row.costImpact, currency, scheduleDays: row.scheduleImpactDays }),
        links: [],
      });
    }
  }

  const decisionIds = ids('decision');
  if (decisionIds.length > 0) {
    const t = schema.projectDecisions;
    for (const row of await db.select().from(t).where(inArray(t.id, decisionIds))) {
      out.set(keyOf('decision', row.id), {
        projectId: row.projectId,
        code: `DEC-${row.number}`,
        title: row.title,
        summary: summarize(row.context),
        impacts: [],
        links: [],
      });
    }
  }

  const deliverableSubjects = ids('deliverable');
  if (deliverableSubjects.length > 0) {
    const t = schema.projectDeliverables;
    for (const row of await db.select().from(t).where(inArray(t.id, deliverableSubjects))) {
      out.set(keyOf('deliverable', row.id), {
        projectId: row.projectId,
        code: deliverableCode(row.number),
        title: row.title,
        summary: summarize(row.description),
        impacts: [],
        links: [],
      });
    }
  }

  const gateIds = ids('gate');
  if (gateIds.length > 0) {
    const t = schema.projectPhases;
    for (const row of await db.select().from(t).where(inArray(t.id, gateIds))) {
      out.set(keyOf('gate', row.id), { projectId: row.projectId, code: null, title: row.name, summary: null, impacts: [], links: [] });
    }
  }

  const closeIds = ids('project_close');
  if (closeIds.length > 0) {
    for (const row of await db
      .select({ id: schema.projects.id, name: schema.projects.name })
      .from(schema.projects)
      .where(inArray(schema.projects.id, closeIds))) {
      out.set(keyOf('project_close', row.id), { projectId: row.id, code: null, title: row.name, summary: null, impacts: [], links: [] });
    }
  }

  const requestIds = ids('project_request');
  if (requestIds.length > 0) {
    const t = schema.projectRequests;
    for (const row of await db.select().from(t).where(inArray(t.id, requestIds))) {
      out.set(keyOf('project_request', row.id), {
        projectId: null,
        code: `REQ-${row.number}`,
        title: row.title,
        summary: summarize(row.businessCase),
        impacts: reviewImpacts({ cost: row.estimatedCost }),
        links: [],
      });
    }
  }
  return out;
}

export async function projectNamesOf(db: Database, projectIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(projectIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(inArray(schema.projects.id, ids));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** The live rows of subjects, grouped by `type:id`, in step order. */
async function siblingsOf(db: Database, rows: readonly Pick<ApprovalRow, 'subjectId'>[]): Promise<Map<string, ApprovalRow[]>> {
  const ids = [...new Set(rows.map((row) => row.subjectId))];
  const out = new Map<string, ApprovalRow[]>();
  if (ids.length === 0) return out;
  const found = await db
    .select()
    .from(approvals)
    .where(and(inArray(approvals.subjectId, ids), isNull(approvals.deletedAt)))
    .orderBy(asc(approvals.step), asc(approvals.createdAt), asc(approvals.id));
  for (const row of found) {
    const key = keyOf(row.subjectType, row.subjectId);
    const list = out.get(key);
    if (list) list.push(row);
    else out.set(key, [row]);
  }
  return out;
}

// ── My reviews ──────────────────────────────────────────────────────────────

function reviewItemOf(
  row: ApprovalRow,
  info: SubjectInfo | undefined,
  siblings: readonly ApprovalRow[],
  projectName: string | null,
  now: Date,
  viaDelegation: boolean,
): ReviewItem {
  return {
    id: row.id,
    source: 'approval',
    type: row.subjectType,
    subjectId: row.subjectId,
    projectId: row.projectId ?? info?.projectId ?? null,
    projectName,
    code: info?.code ?? null,
    title: info?.title ?? row.subjectId,
    summary: info?.summary ?? null,
    requestedBy: row.createdBy,
    requestedAt: row.createdAt.toISOString(),
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    bucket: reviewBucket(row.dueAt, now),
    decision: row.decision,
    note: row.note,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    step: row.step,
    roleLabel: row.roleLabel,
    rule: row.rule ? { code: row.rule.code, ...(row.rule.params ? { params: row.rule.params } : {}) } : null,
    viaDelegation,
    delegatedFrom: row.delegatedFrom,
    actionable: isStepActive(row, siblings),
    approvers: siblings.map(presentReviewApprover),
    impacts: info?.impacts ?? [],
    links: info?.links ?? [],
  };
}

/** Turn approval rows into review items with their subject, project and approvers. */
export async function buildReviewItems(
  db: Database,
  rows: readonly ApprovalRow[],
  userId: string,
  now: Date,
): Promise<ReviewItem[]> {
  if (rows.length === 0) return [];
  const [info, siblings] = await Promise.all([loadSubjectInfo(db, rows), siblingsOf(db, rows)]);
  const names = await projectNamesOf(db, [...rows.map((row) => row.projectId), ...[...info.values()].map((i) => i.projectId)]);
  return rows.map((row) => {
    const subject = info.get(keyOf(row.subjectType, row.subjectId));
    const projectId = row.projectId ?? subject?.projectId ?? null;
    return reviewItemOf(
      row,
      subject,
      siblings.get(keyOf(row.subjectType, row.subjectId)) ?? [row],
      projectId ? (names.get(projectId) ?? null) : null,
      now,
      row.approverId !== userId,
    );
  });
}

type TimeEntryRow = typeof schema.timeEntries.$inferSelect;

/** The pending time entries on projects the caller manages (never their own), oldest first. */
export async function listPendingTimeEntries(
  db: Database,
  userId: string,
  scopeAll: boolean,
  filters: { projectId?: string; limit?: number } = {},
): Promise<Array<TimeEntryRow & { projectName: string | null }>> {
  const te = schema.timeEntries;
  const managed = scopeAll
    ? sql`true`
    : sql`(${schema.projects.projectManagerId} = ${userId} or exists (
        select 1 from ${schema.projectMembers} pm
        where pm.project_id = ${schema.projects.id} and pm.user_id = ${userId}
          and pm.is_active = true and pm.deleted_at is null and lower(pm.role) in ('owner', 'admin')))`;
  const rows = await db
    .select({ entry: te, projectName: schema.projects.name })
    .from(te)
    .innerJoin(schema.projects, and(eq(schema.projects.id, te.projectId), isNull(schema.projects.deletedAt)))
    .where(
      and(
        isNull(te.deletedAt),
        inArray(te.status, ['draft', 'submitted']),
        sql`${te.userId} <> ${userId}`,
        sql`${te.duration} > 0`,
        managed,
        filters.projectId ? eq(te.projectId, filters.projectId) : undefined,
      ),
    )
    .orderBy(asc(te.date), asc(te.id))
    .limit(Math.min(Math.max(filters.limit ?? 200, 1), 500));
  return rows.map((row) => ({ ...row.entry, projectName: row.projectName }));
}

/** A pending time entry as a line of My reviews. */
export function timesheetReviewItem(entry: TimeEntryRow & { projectName: string | null }, now: Date): ReviewItem {
  const hours = hoursOfMinutes(entry.duration);
  const title = (entry.description ?? '').trim() || (entry.activity ?? '').trim() || 'Time entry';
  return {
    id: entry.id,
    source: 'timesheet',
    type: 'timesheet',
    subjectId: entry.id,
    projectId: entry.projectId,
    projectName: entry.projectName,
    code: null,
    title,
    summary: `${entry.date} · ${hours}h`,
    requestedBy: entry.userId,
    requestedAt: entry.createdAt.toISOString(),
    dueAt: null,
    bucket: reviewBucket(null, now),
    decision: 'pending',
    note: null,
    decidedAt: null,
    step: 1,
    roleLabel: null,
    rule: null,
    viaDelegation: false,
    delegatedFrom: null,
    actionable: true,
    approvers: [],
    impacts: reviewImpacts({ hours }),
    links: [],
  };
}

export interface MineOptions {
  userId: string;
  scopeAll: boolean;
  /** The caller may review time entries (`time:update`). */
  canReviewTime: boolean;
  type?: ReviewType;
  projectId?: string;
  now: Date;
}

/** `GET /mine`: the caller's open reviews in groups, with the per-type counts. */
export async function loadMyReviews(db: Database, options: MineOptions): Promise<MyReviews> {
  const { userId, now } = options;
  const pending = await listPendingForApprover(db, userId, { projectId: options.projectId, now });
  const approvalItems = await buildReviewItems(db, pending.map((review) => review.approval), userId, now);
  const timesheets =
    options.canReviewTime && (!options.type || options.type === 'timesheet')
      ? (await listPendingTimeEntries(db, userId, options.scopeAll, { projectId: options.projectId })).map((entry) => timesheetReviewItem(entry, now))
      : [];
  // The type chips show how many of each type wait, whatever the filter selects.
  const counts: Record<string, number> = {};
  for (const item of approvalItems) counts[item.type] = (counts[item.type] ?? 0) + 1;
  if (options.canReviewTime) {
    counts.timesheet = options.type && options.type !== 'timesheet'
      ? (await listPendingTimeEntries(db, userId, options.scopeAll, { projectId: options.projectId })).length
      : timesheets.length;
  }

  const all = [...approvalItems, ...timesheets].filter((item) => !options.type || item.type === options.type);
  all.sort(compareItems);
  return {
    total: all.length,
    counts,
    groups: {
      overdue: all.filter((item) => item.bucket === 'overdue'),
      this_week: all.filter((item) => item.bucket === 'this_week'),
      later: all.filter((item) => item.bucket === 'later'),
    },
  };
}

/** The order of My reviews: earliest due date first (no date last), then oldest request, then id. */
function compareItems(a: ReviewItem, b: ReviewItem): number {
  const due = (item: ReviewItem) => (item.dueAt ? new Date(item.dueAt).getTime() : Number.POSITIVE_INFINITY);
  if (due(a) !== due(b)) return due(a) < due(b) ? -1 : 1;
  const requested = new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime();
  if (requested !== 0) return requested;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * `GET /mine/count`: the sidebar badge, which every platform page polls, so it is
 * one indexed `count(*)` over the caller's pending rows (their own and those of
 * members who delegated to them, whose earlier steps are answered), and a second
 * `count(*)` for the pending time entries on projects they manage. Nothing is
 * loaded or enriched.
 */
export async function countMyReviews(db: Database, options: Omit<MineOptions, 'type' | 'projectId'>): Promise<{ count: number; overdue: number }> {
  const { userId, now } = options;
  const a = approvals;
  const dlg = schema.flowApprovalDelegations;
  const delegators = db
    .select({ id: dlg.memberId })
    .from(dlg)
    .where(and(eq(dlg.delegateId, userId), isNull(dlg.deletedAt), lte(dlg.startsAt, now), gt(dlg.endsAt, now)));
  const [row] = await db
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
      overdue: sql<number>`count(*) filter (where ${a.dueAt} < ${now})`.mapWith(Number),
    })
    .from(a)
    .where(
      and(
        eq(a.approverKind, 'member'),
        eq(a.decision, 'pending'),
        isNull(a.deletedAt),
        or(eq(a.approverId, userId), inArray(a.approverId, delegators)),
        // Its turn: no row of an earlier step is still unanswered or declined.
        sql`not exists (
          select 1 from flow_approvals s
          where s.subject_type = ${a.subjectType} and s.subject_id = ${a.subjectId} and s.deleted_at is null
            and s.step < ${a.step} and s.decision not in ('approved', 'approved_with_conditions'))`,
      ),
    );
  const timesheets = options.canReviewTime ? await countPendingTimeEntries(db, userId, options.scopeAll) : 0;
  return { count: (row?.count ?? 0) + timesheets, overdue: row?.overdue ?? 0 };
}

/** How many time entries wait for the caller on the projects they manage (never their own). */
export async function countPendingTimeEntries(db: Database, userId: string, scopeAll: boolean): Promise<number> {
  const te = schema.timeEntries;
  const managed = scopeAll
    ? sql`true`
    : sql`(${schema.projects.projectManagerId} = ${userId} or exists (
        select 1 from ${schema.projectMembers} pm
        where pm.project_id = ${schema.projects.id} and pm.user_id = ${userId}
          and pm.is_active = true and pm.deleted_at is null and lower(pm.role) in ('owner', 'admin')))`;
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(te)
    .innerJoin(schema.projects, and(eq(schema.projects.id, te.projectId), isNull(schema.projects.deletedAt)))
    .where(and(isNull(te.deletedAt), inArray(te.status, ['draft', 'submitted']), sql`${te.userId} <> ${userId}`, sql`${te.duration} > 0`, managed));
  return row?.n ?? 0;
}

// ── Sent by me and Done ─────────────────────────────────────────────────────

/** Parsed `GET /sent` and `/done` filters. */
export interface ListFilters {
  type?: ReviewType;
  projectId?: string;
  cursor?: string;
  limit: number;
}

/** `GET /sent`: subjects the caller asked approval for that still wait for someone, newest request first. */
export async function loadSentReviews(
  db: Database,
  userId: string,
  filters: ListFilters,
  now: Date,
): Promise<{ items: SentReview[]; hasMore: boolean; nextCursor: string | null; total: number }> {
  if (filters.type === 'timesheet') return { items: [], hasMore: false, nextCursor: null, total: 0 };
  const scope = and(
    eq(approvals.createdBy, userId),
    isNull(approvals.deletedAt),
    filters.type ? eq(approvals.subjectType, filters.type) : undefined,
    filters.projectId ? eq(approvals.projectId, filters.projectId) : undefined,
  );
  const subjects = db
    .select({
      subjectType: approvals.subjectType,
      subjectId: approvals.subjectId,
      requestedAt: sql<Date>`min(${approvals.createdAt})`.mapWith(approvals.createdAt).as('requested_at'),
    })
    .from(approvals)
    .where(scope)
    .groupBy(approvals.subjectType, approvals.subjectId)
    .having(sql`bool_or(${approvals.decision} in ('pending', 'info_requested'))`)
    .as('subjects');

  let cursorWhere = sql`true`;
  if (filters.cursor) {
    const [cur] = await db
      .select({ requestedAt: subjects.requestedAt, subjectId: subjects.subjectId })
      .from(subjects)
      .where(eq(subjects.subjectId, filters.cursor))
      .limit(1);
    if (cur) cursorWhere = sql`(${subjects.requestedAt} < ${cur.requestedAt} or (${subjects.requestedAt} = ${cur.requestedAt} and ${subjects.subjectId} < ${cur.subjectId}))`;
  }
  const [page, [count]] = await Promise.all([
    db
      .select()
      .from(subjects)
      .where(cursorWhere)
      .orderBy(desc(subjects.requestedAt), desc(subjects.subjectId))
      .limit(filters.limit + 1),
    db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(subjects),
  ]);
  const hasMore = page.length > filters.limit;
  const slice = hasMore ? page.slice(0, filters.limit) : page;
  const nextCursor = hasMore && slice.length > 0 ? (slice[slice.length - 1] as { subjectId: string }).subjectId : null;

  const siblings = await siblingsOf(db, slice);
  const info = await loadSubjectInfo(db, slice);
  const rowsOf = slice.map((subject) => siblings.get(keyOf(subject.subjectType, subject.subjectId)) ?? []);
  const names = await projectNamesOf(db, [...rowsOf.flat().map((row) => row.projectId), ...[...info.values()].map((i) => i.projectId)]);
  const items: SentReview[] = slice.map((subject, index) => {
    const rows = rowsOf[index] ?? [];
    const subjectInfo = info.get(keyOf(subject.subjectType, subject.subjectId));
    const projectId = rows[0]?.projectId ?? subjectInfo?.projectId ?? null;
    const dues = rows.filter((row) => row.dueAt).map((row) => (row.dueAt as Date).getTime());
    const outcome: ApprovalOutcome = resolveSubjectRows(subject.subjectType, rows);
    return {
      type: subject.subjectType,
      subjectId: subject.subjectId,
      projectId,
      projectName: projectId ? (names.get(projectId) ?? null) : null,
      code: subjectInfo?.code ?? null,
      title: subjectInfo?.title ?? subject.subjectId,
      requestedAt: subject.requestedAt.toISOString(),
      dueAt: dues.length > 0 ? new Date(Math.min(...dues)).toISOString() : null,
      outcome,
      approvers: rows.map(presentReviewApprover),
    };
  });
  return { items, hasMore, nextCursor, total: count?.n ?? 0 };
}

/** `GET /done`: the reviews the caller answered, newest first. */
export async function loadDoneReviews(
  db: Database,
  userId: string,
  filters: ListFilters,
  now: Date,
): Promise<{ items: ReviewItem[]; hasMore: boolean; nextCursor: string | null; total: number }> {
  if (filters.type === 'timesheet') return { items: [], hasMore: false, nextCursor: null, total: 0 };
  const where = and(
    eq(approvals.decidedBy, userId),
    isNull(approvals.deletedAt),
    inArray(approvals.decision, ['approved', 'approved_with_conditions', 'rejected']),
    filters.type ? eq(approvals.subjectType, filters.type) : undefined,
    filters.projectId ? eq(approvals.projectId, filters.projectId) : undefined,
  );
  const countWhere = where;
  let cursorWhere = sql`true`;
  if (filters.cursor) {
    const [cur] = await db.select({ decidedAt: approvals.decidedAt, id: approvals.id }).from(approvals).where(eq(approvals.id, filters.cursor)).limit(1);
    if (cur?.decidedAt) cursorWhere = sql`(${approvals.decidedAt} < ${cur.decidedAt} or (${approvals.decidedAt} = ${cur.decidedAt} and ${approvals.id} < ${cur.id}))`;
  }
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(approvals)
      .where(and(where, cursorWhere))
      .orderBy(desc(approvals.decidedAt), desc(approvals.id))
      .limit(filters.limit + 1),
    db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(approvals).where(countWhere),
  ]);
  const hasMore = rows.length > filters.limit;
  const slice = hasMore ? rows.slice(0, filters.limit) : rows;
  const nextCursor = hasMore && slice.length > 0 ? (slice[slice.length - 1] as ApprovalRow).id : null;
  return { items: await buildReviewItems(db, slice, userId, now), hasMore, nextCursor, total: count?.n ?? 0 };
}

