/**
 * Approval reminders: the daily `approval_due` sweep (FLOW-016). A day before a
 * review is due its approver is reminded, and once it is overdue the member who
 * asked for it is told, each once (`reminded_at`, `overdue_notified_at`).
 *
 * Scheduling follows ADR DATA-008 (nothing opens tenant databases on a timer):
 * whatever asks for approvals (`announceApprovalsRequested`) marks its workspace
 * due in the schedule-index D1 (`workspace_due_index`, kind `approval_due`) at
 * the earliest reminder. The daily tick reads only that index, opens just the
 * due workspaces, announces what came due and stores when the workspace is next
 * due (or drops the row). Approvals only exist since this index does, so the
 * one-time seed has nothing to add.
 */

import { and, asc, eq, isNull, lte, gt, isNotNull, sql } from 'drizzle-orm';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getTenantDbForWorkspace, schema, type Database } from '@weldsuite/worker-kit/db';
import { runDueIndexSweep, type DueIndexSweepResult } from '@weldsuite/worker-kit/due-index';
import { isStepActive, listSubjectApprovals, type ApprovalRow } from '@weldsuite/flow-domain/approvals';
import { approvalEventData } from '@weldsuite/flow-domain/approval-views';
import type { Env } from '../types';
import { loadSubjectInfo, projectNamesOf, sendApprovalNotification, type SubjectInfo } from '../services/approvals';

/** The cron expression that runs this sweep; keep in step with wrangler.toml. */
export const APPROVAL_DUE_CRONS = ['30 3 * * *'] as const;

export function isApprovalDueCron(cron: string): boolean {
  return (APPROVAL_DUE_CRONS as readonly string[]).includes(cron);
}

/** KV flag for the due index's one-time seed (nothing to seed: see above). */
export const APPROVAL_DUE_SEED_KEY = 'flow:approval-due-index:seed:v1';

/** A workspace that failed (Neon hiccup, broken tenant) is retried after this. */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
/** Reviews per workspace per tick and kind; the rest stay due for the next tick. */
const ROWS_PER_TICK = 200;
const DAY_MS = 86_400_000;

const t = schema.flowApprovals;

/** Whether the row's earlier steps are answered: only then is the review its approver's to answer. */
async function isActionable(db: Database, row: ApprovalRow): Promise<boolean> {
  return isStepActive(row, await listSubjectApprovals(db, row.subjectType, row.subjectId));
}

async function labelsFor(db: Database, rows: readonly ApprovalRow[]) {
  const info = await loadSubjectInfo(db, rows);
  const names = await projectNamesOf(db, [...rows.map((row) => row.projectId), ...[...info.values()].map((i) => i.projectId)]);
  return (row: ApprovalRow): { label: { code: string | null; title: string }; projectName: string | null; info: SubjectInfo | undefined } => {
    const subject = info.get(`${row.subjectType}:${row.subjectId}`);
    const projectId = row.projectId ?? subject?.projectId ?? null;
    return {
      label: { code: subject?.code ?? null, title: subject?.title ?? row.subjectId },
      projectName: projectId ? (names.get(projectId) ?? null) : null,
      info: subject,
    };
  };
}

export interface ApprovalSweepResult {
  reminded: number;
  overdue: number;
}

/**
 * One workspace's reminders and overdue notices at `now`. Returns how many went
 * out. `announceOverdue` publishes the `flow_approval.overdue` event and is
 * replaceable for tests.
 */
export async function sweepWorkspaceApprovals(
  env: Env,
  db: Database,
  orgId: string,
  now: Date,
  announceOverdue: (row: ApprovalRow) => Promise<unknown> = (row) =>
    publishEntityEventRaw({
      env,
      workspaceId: orgId,
      userId: 'system',
      entityType: 'flow_approval',
      action: 'overdue',
      entityId: row.id,
      data: approvalEventData(row),
    }),
): Promise<ApprovalSweepResult> {
  const result: ApprovalSweepResult = { reminded: 0, overdue: 0 };
  const base = { db, env, clerkOrgId: orgId };

  // Due within a day, not yet reminded.
  const dueSoon = await db
    .select()
    .from(t)
    .where(
      and(
        eq(t.decision, 'pending'),
        isNull(t.deletedAt),
        isNull(t.remindedAt),
        isNotNull(t.dueAt),
        lte(t.dueAt, new Date(now.getTime() + DAY_MS)),
        gt(t.dueAt, now),
      ),
    )
    .orderBy(asc(t.dueAt), asc(t.id))
    .limit(ROWS_PER_TICK);
  if (dueSoon.length > 0) {
    const describe = await labelsFor(db, dueSoon);
    for (const row of dueSoon) {
      try {
        if (row.approverKind === 'member' && (await isActionable(db, row))) {
          const { label, projectName } = describe(row);
          await sendApprovalNotification(base, { userId: row.approverId, approvalId: row.id, kind: 'reminder', label, projectName });
          result.reminded += 1;
        }
        await db.update(t).set({ remindedAt: now }).where(eq(t.id, row.id));
      } catch (err) {
        console.error(`[ApprovalDue] reminder for ${row.id} in ${orgId} failed:`, err);
      }
    }
  }

  // Past due, the requester not yet told.
  const late = await db
    .select()
    .from(t)
    .where(
      and(eq(t.decision, 'pending'), isNull(t.deletedAt), isNull(t.overdueNotifiedAt), isNotNull(t.dueAt), lte(t.dueAt, now)),
    )
    .orderBy(asc(t.dueAt), asc(t.id))
    .limit(ROWS_PER_TICK);
  if (late.length > 0) {
    const describe = await labelsFor(db, late);
    for (const row of late) {
      try {
        if (await isActionable(db, row)) {
          const { label, projectName } = describe(row);
          // The reminder is moot for a review that is already late.
          await sendApprovalNotification(base, { userId: row.createdBy, approvalId: row.id, kind: 'overdue', label, projectName });
          await announceOverdue(row);
          result.overdue += 1;
        }
        await db.update(t).set({ overdueNotifiedAt: now, remindedAt: row.remindedAt ?? now }).where(eq(t.id, row.id));
      } catch (err) {
        console.error(`[ApprovalDue] overdue notice for ${row.id} in ${orgId} failed:`, err);
      }
    }
  }
  return result;
}

/**
 * When the workspace next has a reminder or an overdue notice to send (null:
 * none). Re-derived from the tenant after every tick, so the index never drifts
 * from what is actually waiting.
 */
export async function nextApprovalDueAt(db: Database): Promise<Date | null> {
  const [row] = await db
    .select({
      next: sql<Date | null>`min(case when ${t.remindedAt} is null then ${t.dueAt} - interval '1 day' else ${t.dueAt} end)`.mapWith(t.dueAt),
    })
    .from(t)
    .where(and(eq(t.decision, 'pending'), isNull(t.deletedAt), isNotNull(t.dueAt), isNull(t.overdueNotifiedAt)));
  return row?.next ?? null;
}

/** The daily tick: opens only the workspaces the `approval_due` due index lists as due. */
export async function runApprovalReminders(env: Env, now: Date = new Date()): Promise<DueIndexSweepResult & ApprovalSweepResult> {
  const total: ApprovalSweepResult = { reminded: 0, overdue: 0 };
  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'approval_due',
    label: '[ApprovalDue]',
    seed: { key: APPROVAL_DUE_SEED_KEY, listWorkspaces: async () => [] },
    retryAfterMs: RETRY_AFTER_MS,
    now: now.getTime(),
    process: async (orgId, at) => {
      const db = (await getTenantDbForWorkspace(env, orgId)) as unknown as Database;
      const done = await sweepWorkspaceApprovals(env, db, orgId, at);
      total.reminded += done.reminded;
      total.overdue += done.overdue;
      return nextApprovalDueAt(db);
    },
  });
  if (result.due > 0 || result.failed > 0) {
    console.log(`[ApprovalDue] due=${result.due} processed=${result.processed} failed=${result.failed}: ${total.reminded} reminded, ${total.overdue} overdue`);
  }
  return { ...result, ...total };
}
