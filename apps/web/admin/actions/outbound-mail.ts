'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import {
  outboundCaseReviewSchema,
  outboundPolicyUpdateSchema,
} from '@weldsuite/app-api-client/schemas/outbound-mail';
import { guardWrite } from '@/lib/auth';
import { recordConsoleAudit, recordConsoleAuditOrRefuse } from '@/lib/audit';
import { getMasterDb, masterSchema } from '@/lib/db';
import { generateId } from '@/lib/id';
import { queueOutboundReview, refreshOutboundLedger } from '@/lib/mail-api';
import {
  CASE_STATUS_LABELS,
  DEFAULT_POLICY,
  SNIPPET_AUDIT_ACTION,
  cleanLimitOverrides,
  isCaseStatus,
  isOutboundState,
  isTrustLevel,
  planPolicyUpdate,
  type OutboundCaseStatus,
  type OutboundState,
  type PlannedOutboundEvent,
  type PolicySnapshot,
} from '@/lib/outbound-mail';
import type { ActionResult } from './workspaces';

const { outboundMailPolicies: policies, outboundMailCases: cases, outboundMailEvents: events, workspaces } = masterSchema;

/**
 * Staff actions on the outbound mail guard (docs/plans/weldmail-outbound-abuse.md,
 * "Staff tooling"). Every action: `guardWrite()` (no read-only viewers), a
 * guarded master-DB write, a row in `outbound_mail_events` where the guard's
 * trail has a kind for it, an admin audit row, and a revalidate of the screens.
 *
 * The mail-api ledger reloads a workspace's policy within a minute on its own;
 * a policy change also asks it to reload at once (best effort).
 */

const CONFLICT = 'Someone else (or the guard itself) just changed this. Reload the page and try again.';
const NOT_CONFIGURED = 'mail-api is not configured for this console (MAIL_API_URL, OUTBOUND_ADMIN_SECRET).';

function isId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function refresh(workspaceId: string | null): void {
  revalidatePath('/outbound-mail');
  if (workspaceId) {
    revalidatePath(`/outbound-mail/${workspaceId}`);
    revalidatePath(`/workspaces/${workspaceId}`);
  }
}

type LiveWorkspace = { ok: true; id: string } | { ok: false; error: string };

async function loadLiveWorkspace(workspaceId: string): Promise<LiveWorkspace> {
  const [row] = await getMasterDb()
    .select({ id: workspaces.id, deletedAt: workspaces.deletedAt })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!row) return { ok: false, error: 'Workspace not found.' };
  if (row.deletedAt) return { ok: false, error: 'This workspace has been deleted.' };
  return { ok: true, id: row.id };
}

/** Audit target for a case: its workspace, or the personal account / platform it is about. */
function caseAuditTarget(row: {
  workspaceId: string | null;
  personalAccountId: string | null;
}): { workspaceId: string } | { workspaceId: null; targetId: string } {
  if (row.workspaceId) return { workspaceId: row.workspaceId };
  return { workspaceId: null, targetId: row.personalAccountId ? `personal:${row.personalAccountId}` : 'platform' };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface OutboundPolicyActionData {
  state: OutboundState;
  /** Shown as warning toasts by ActionDialog. */
  warnings: string[];
}

type MasterDb = ReturnType<typeof getMasterDb>;

/** The stored row (id and raw state, for the guarded write) and its snapshot; the defaults when there is no row. */
interface StoredPolicy {
  rowId: string | null;
  rawState: (typeof policies.$inferSelect)['state'] | null;
  current: PolicySnapshot;
}

function issueMessage(issue: { path: (string | number)[]; message: string } | undefined, fallback: string): string {
  if (!issue) return fallback;
  const where = issue.path.join('.') || 'policy';
  return `${where}: ${issue.message}`;
}

async function loadPolicy(db: MasterDb, workspaceId: string): Promise<StoredPolicy> {
  const [row] = await db
    .select({
      id: policies.id,
      trustOverride: policies.trustOverride,
      limits: policies.limits,
      state: policies.state,
      stateReason: policies.stateReason,
      allowRepliesWhenSuspended: policies.allowRepliesWhenSuspended,
      notes: policies.notes,
    })
    .from(policies)
    .where(eq(policies.workspaceId, workspaceId))
    .limit(1);
  if (!row) return { rowId: null, rawState: null, current: DEFAULT_POLICY };
  return {
    rowId: row.id,
    rawState: row.state,
    current: {
      trustOverride: isTrustLevel(row.trustOverride) ? row.trustOverride : null,
      limits: cleanLimitOverrides(row.limits),
      state: isOutboundState(row.state) ? row.state : 'active',
      stateReason: row.stateReason,
      allowRepliesWhenSuspended: row.allowRepliesWhenSuspended,
      notes: row.notes,
    },
  };
}

type PolicyValues = PolicySnapshot & { updatedAt: Date; stateSetBy?: string; stateSetAt?: Date };

/** Update the row (guarded on the state we planned from) or insert one. False on a lost race. */
async function savePolicy(db: MasterDb, workspaceId: string, stored: StoredPolicy, values: PolicyValues): Promise<boolean> {
  if (stored.rowId && stored.rawState) {
    // The guard may have tightened the state meanwhile; then this write must not undo it.
    const updated = await db
      .update(policies)
      .set(values)
      .where(and(eq(policies.id, stored.rowId), eq(policies.state, stored.rawState)))
      .returning({ id: policies.id });
    return updated.length > 0;
  }
  const inserted = await db
    .insert(policies)
    .values({ id: generateId('obpol'), workspaceId, ...values })
    .onConflictDoNothing()
    .returning({ id: policies.id });
  return inserted.length > 0;
}

/** The trail rows for a staff change. Returns a warning when they could not be written (the change stands). */
async function writeTrail(
  db: MasterDb,
  workspaceId: string,
  planned: PlannedOutboundEvent[],
  reason: string,
  actor: string,
): Promise<string | null> {
  if (planned.length === 0) return null;
  try {
    await db.insert(events).values(
      planned.map((event) => ({
        id: generateId('obevt'),
        workspaceId,
        personalAccountId: null,
        kind: event.kind,
        fromValue: event.fromValue,
        toValue: event.toValue,
        reason,
        actor,
        details: event.details ?? null,
      })),
    );
    return null;
  } catch (err) {
    console.error('[admin/outbound-mail] writing the trail failed:', err);
    return 'Saved, but the outbound trail could not be written. The activity log has the change.';
  }
}

function reloadWarning(result: { code: string; error: string }): string {
  if (result.code === 'NOT_CONFIGURED') {
    return 'Saved. Live refresh is not configured here, so sending picks up the change within a minute.';
  }
  return `Saved, but mail-api did not reload the policy (${result.error}). Sending picks it up within a minute.`;
}

/**
 * Change a workspace's sending policy: trust override, limit overrides, state
 * (with the reason the customer sees), replies while suspended, staff notes.
 * `reason` is the staff reason for the change; it goes to the trail and the
 * activity log, never to the customer.
 */
export async function updateOutboundPolicy(
  workspaceId: string,
  input: unknown,
  reason: string,
): Promise<ActionResult<OutboundPolicyActionData>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!isId(workspaceId, 255) || typeof reason !== 'string') return { ok: false, error: 'Invalid request.' };
  if (reason.trim().length < 3) return { ok: false, error: 'Give a reason of at least 3 characters.' };

  const parsed = outboundPolicyUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: issueMessage(parsed.error.issues[0], 'The policy is not valid.') };

  const workspace = await loadLiveWorkspace(workspaceId);
  if (!workspace.ok) return workspace;

  const db = getMasterDb();
  const stored = await loadPolicy(db, workspaceId);
  const plan = planPolicyUpdate(stored.current, parsed.data);
  if (!plan.ok) return { ok: false, error: plan.error };
  if (plan.changed.length === 0) return { ok: false, error: 'Nothing changed.' };

  const { identity } = guard;
  const now = new Date();
  const saved = await savePolicy(db, workspaceId, stored, {
    ...plan.next,
    updatedAt: now,
    ...(plan.stateChanged ? { stateSetBy: identity.email, stateSetAt: now } : {}),
  });
  if (!saved) return { ok: false, error: CONFLICT };

  const warnings: string[] = [];
  const trailWarning = await writeTrail(db, workspaceId, plan.events, reason.trim(), identity.email);
  if (trailWarning) warnings.push(trailWarning);

  await recordConsoleAudit({
    identity,
    workspaceId,
    action: 'outbound_mail.policy_update',
    outcome: 'success',
    reason: reason.trim(),
    details: { changed: plan.changed, before: stored.current, after: plan.next },
  });

  const reload = await refreshOutboundLedger(identity, workspaceId);
  if (!reload.ok) warnings.push(reloadWarning(reload));

  refresh(workspaceId);
  return { ok: true, data: { state: plan.next.state, warnings } };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export interface OutboundCaseActionData {
  id: string;
  status: OutboundCaseStatus;
}

async function loadCase(caseId: string) {
  const [row] = await getMasterDb()
    .select({
      id: cases.id,
      workspaceId: cases.workspaceId,
      personalAccountId: cases.personalAccountId,
      trigger: cases.trigger,
      status: cases.status,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);
  return row ?? null;
}

/** Confirm a case (it was abuse) or dismiss it (a false positive). The notes are the labelled data for tuning. */
export async function reviewOutboundCase(caseId: string, input: unknown): Promise<ActionResult<OutboundCaseActionData>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!isId(caseId, 30)) return { ok: false, error: 'Invalid request.' };

  const parsed = outboundCaseReviewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'The review is not valid.' };
  const { status, notes } = parsed.data;

  const row = await loadCase(caseId);
  if (!row) return { ok: false, error: 'Case not found.' };
  const from: OutboundCaseStatus = isCaseStatus(row.status) ? row.status : 'open';
  if (from === status) return { ok: false, error: `This case is already ${CASE_STATUS_LABELS[status].toLowerCase()}.` };

  const { identity } = guard;
  const now = new Date();
  const db = getMasterDb();
  const updated = await db
    .update(cases)
    .set({ status, reviewedBy: identity.email, reviewedAt: now, reviewNotes: notes || null, updatedAt: now })
    .where(and(eq(cases.id, row.id), eq(cases.status, row.status)))
    .returning({ id: cases.id });
  if (updated.length === 0) return { ok: false, error: CONFLICT };

  try {
    await db.insert(events).values({
      id: generateId('obevt'),
      workspaceId: row.workspaceId,
      personalAccountId: row.personalAccountId,
      kind: 'case_reviewed',
      fromValue: from,
      toValue: status,
      reason: notes || null,
      actor: identity.email,
      details: { caseId: row.id, trigger: row.trigger },
    });
  } catch (err) {
    console.error('[admin/outbound-mail] writing the trail failed:', err);
  }

  await recordConsoleAudit({
    identity,
    ...caseAuditTarget(row),
    action: 'outbound_mail.case_review',
    outcome: 'success',
    reason: notes || null,
    details: { caseId: row.id, trigger: row.trigger, from, to: status },
  });

  refresh(row.workspaceId);
  return { ok: true, data: { id: row.id, status } };
}

/**
 * Show a case's template snippet. It is customer mail content, so the view is
 * recorded in the activity log first; when that fails, the snippet stays hidden.
 */
export async function revealOutboundSnippet(caseId: string): Promise<ActionResult<{ snippet: string }>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!isId(caseId, 30)) return { ok: false, error: 'Invalid request.' };

  const [row] = await getMasterDb()
    .select({
      id: cases.id,
      workspaceId: cases.workspaceId,
      personalAccountId: cases.personalAccountId,
      trigger: cases.trigger,
      snippet: cases.snippet,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);
  if (!row) return { ok: false, error: 'Case not found.' };
  if (!row.snippet) return { ok: false, error: 'This case has no snippet.' };

  const recorded = await recordConsoleAuditOrRefuse({
    identity: guard.identity,
    ...caseAuditTarget(row),
    action: SNIPPET_AUDIT_ACTION,
    outcome: 'success',
    details: { caseId: row.id, trigger: row.trigger },
  });
  if (!recorded) {
    return { ok: false, error: 'The view could not be recorded in the activity log, so the snippet stays hidden. Try again.' };
  }

  return { ok: true, data: { snippet: row.snippet } };
}

// ---------------------------------------------------------------------------
// AI review
// ---------------------------------------------------------------------------

/** Ask mail-api to run the AI review on the workspace's biggest template today. */
export async function requestOutboundReview(workspaceId: string): Promise<ActionResult<{ queued: boolean }>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!isId(workspaceId, 255)) return { ok: false, error: 'Invalid request.' };

  const workspace = await loadLiveWorkspace(workspaceId);
  if (!workspace.ok) return workspace;

  const result = await queueOutboundReview(guard.identity, workspaceId);
  if (!result.ok) {
    if (result.code === 'NOT_CONFIGURED') return { ok: false, error: NOT_CONFIGURED };
    await recordConsoleAudit({
      identity: guard.identity,
      workspaceId,
      action: 'outbound_mail.request_review',
      outcome: 'failure',
      error: result.error,
    });
    return { ok: false, error: result.error };
  }

  await recordConsoleAudit({
    identity: guard.identity,
    workspaceId,
    action: 'outbound_mail.request_review',
    outcome: 'success',
    details: { queued: result.data.queued },
  });
  refresh(workspaceId);
  return { ok: true, data: { queued: result.data.queued } };
}
