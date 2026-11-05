/**
 * Accepting a risk for flow-api: the approval subject `risk_acceptance`
 * (the sponsor accepts a risk with strategy `accept` that scores 9 or more) and
 * the request behind `POST /api/project-raid/:id/request-acceptance`.
 *
 * Importing this file registers the subject handler and its aftermath. On
 * approval the risk moves to `monitoring` and an assessment row notes who
 * accepted it; on rejection the risk stays as it was (the approval row holds
 * the answer).
 */

import type { Context } from 'hono';
import { and, eq, gte, isNull, like } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  cancelPendingApprovals,
  listSubjectApprovals,
  registerApprovalSubject,
  requestApprovals,
  sponsorOf,
  isOpenDecision,
  type ApprovalRow,
} from '@weldsuite/flow-domain/approvals';
import {
  ACCEPTANCE_DUE_DAYS,
  ACCEPTANCE_MESSAGES,
  acceptanceApproverRow,
  acceptanceAssessmentNote,
} from '@weldsuite/flow-domain/acceptance';
import { raidCode, raidEventData } from '@weldsuite/flow-domain/raid';
import type { Env, Variables } from '../types';
import { announceApprovalsCancelled, announceApprovalsRequested, registerApprovalAftermath } from './approvals';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const items = schema.projectRaidItems;
const assessments = schema.projectRaidAssessments;

const NOTE_PREFIX = 'Accepted by the sponsor';

registerApprovalSubject('risk_acceptance', {
  async onResolved(db, subjectId, outcome, context) {
    if (outcome !== 'approved') return;
    const [item] = await db
      .select()
      .from(items)
      .where(and(eq(items.id, subjectId), isNull(items.deletedAt)))
      .limit(1);
    // A risk that was closed or deleted since the request has nothing to accept.
    if (!item || item.kind !== 'risk' || item.closedAt !== null || item.probability === null || item.impact === null) return;
    const requestedAt = context.rows.reduce((earliest, row) => (row.createdAt < earliest ? row.createdAt : earliest), context.now);
    // Idempotent: the resolution may run again, and must not note the acceptance twice.
    const [already] = await db
      .select({ id: assessments.id })
      .from(assessments)
      .where(and(eq(assessments.itemId, subjectId), like(assessments.note, `${NOTE_PREFIX}%`), gte(assessments.assessedAt, requestedAt)))
      .limit(1);
    if (already) return;
    await atomically(db, (handle) => [
      handle.update(items).set({ status: 'monitoring', updatedAt: context.now }).where(and(eq(items.id, subjectId), isNull(items.deletedAt))),
      handle.insert(assessments).values({
        id: generateId('rasm'),
        itemId: subjectId,
        projectId: item.projectId,
        probability: item.probability as number,
        impact: item.impact as number,
        residualProbability: item.residualProbability,
        residualImpact: item.residualImpact,
        note: acceptanceAssessmentNote(context.rows),
        assessedBy: context.actor?.id ?? item.createdBy,
        assessedAt: context.now,
      }),
    ]);
  },
});

registerApprovalAftermath('risk_acceptance', async (c, info) => {
  if (info.outcome !== 'approved') return;
  const [row] = await c.get('tenantDb').select().from(items).where(eq(items.id, info.subjectId)).limit(1);
  if (row) {
    publishEntityEvent({ c, entityType: 'project_raid_item', entityId: row.id, action: 'updated', data: raidEventData(row) });
  }
});

export type AcceptanceRequestResult =
  | { ok: true; rows: ApprovalRow[] }
  | { ok: false; status: 400 | 409; message: string };

/**
 * Ask the sponsor (the project's `sponsorId`, else its manager) to accept a
 * risk. A request that is still open is refused; one that was answered earlier
 * is cleared first, so a risk can be put to the sponsor again.
 */
export async function requestRiskAcceptance(
  c: AppContext,
  db: Database,
  item: typeof items.$inferSelect,
  note: string | null,
): Promise<AcceptanceRequestResult> {
  const [project] = await db
    .select({ name: schema.projects.name, managerId: schema.projects.projectManagerId, settings: schema.projects.settings })
    .from(schema.projects)
    .where(eq(schema.projects.id, item.projectId))
    .limit(1);
  const sponsorId = sponsorOf(project?.settings, project?.managerId);
  if (!sponsorId) return { ok: false, status: 400, message: ACCEPTANCE_MESSAGES.noSponsor };

  const existing = await listSubjectApprovals(db, 'risk_acceptance', item.id);
  if (existing.some((row) => isOpenDecision(row.decision))) {
    return { ok: false, status: 409, message: ACCEPTANCE_MESSAGES.alreadyRequested };
  }
  const now = new Date();
  if (existing.length > 0) {
    announceApprovalsCancelled(c, await cancelPendingApprovals(db, { subjectType: 'risk_acceptance', subjectId: item.id, includeDecided: true, now }));
  }
  const due = new Date(now.getTime() + ACCEPTANCE_DUE_DAYS * 86_400_000);
  const result = await requestApprovals(db, {
    projectId: item.projectId,
    subjectType: 'risk_acceptance',
    subjectId: item.id,
    requestedBy: c.get('userId'),
    rows: [acceptanceApproverRow(sponsorId, { probability: item.probability as number, impact: item.impact as number }, note, due)],
    now,
  });
  if (!result.ok) return { ok: false, status: 409, message: result.message };
  announceApprovalsRequested(c, {
    rows: result.rows,
    subject: { code: raidCode(item.kind, item.number), title: item.title },
    projectName: project?.name ?? null,
  });
  return { ok: true, rows: result.rows };
}
