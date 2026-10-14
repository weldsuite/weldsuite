/**
 * Enrollments: a prospect's place in a campaign. One row per (campaign,
 * prospect); the send consumer walks it through the steps.
 */

import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  isConsumerEmail,
  type AddReachCampaignProspectsInput,
  type ReachAddProspectsReport,
  type ReachEnrollment,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  reachCampaignMailboxes,
  reachEnrollments,
  reachMailboxes,
  reachProspectListMembers,
  reachProspects,
  type ReachEnrollment as ReachEnrollmentRow,
  type ReachProspect as ReachProspectRow,
} from '@weldsuite/db/schema';
import { loadSuppressionIndex } from './suppressions';

const CHUNK = 500;

type SkipReason = ReachAddProspectsReport['skipped'][number]['reason'];

/**
 * Set `next_send_at` (and optionally the status) of many enrollments with one
 * UPDATE per 500 rows, instead of one per row.
 */
export async function bulkSetNextSendAt(
  db: Database,
  items: ReadonlyArray<{ id: string; at: Date }>,
  options: { status?: 'active'; now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  for (let i = 0; i < items.length; i += CHUNK) {
    const values = sql.join(
      items.slice(i, i + CHUNK).map((item) => sql`(${item.id}, ${item.at.toISOString()}::timestamptz)`),
      sql`, `,
    );
    await db
      .update(reachEnrollments)
      .set({
        nextSendAt: sql`v.at`,
        ...(options.status ? { status: options.status } : {}),
        claimedAt: null,
        updatedAt: now,
      })
      .from(sql`(VALUES ${values}) AS v(id, at)`)
      .where(sql`${reachEnrollments.id} = v.id`);
  }
}

export interface EnrollmentFacts {
  alreadyEnrolled: boolean;
  /** An active or queued enrollment in another campaign. */
  enrolledElsewhere: boolean;
  /** The live suppression list covers the address. */
  suppressed: boolean;
  allowConsumer: boolean;
}

/**
 * Why a prospect cannot join a campaign, or null when it can. The stored
 * `validation` is a hint; suppression and consumer rules are judged live,
 * because the list and the workspace limits change after an import.
 */
export function enrollmentSkipReason(
  prospect: Pick<ReachProspectRow, 'email' | 'validation'>,
  facts: EnrollmentFacts,
): SkipReason | null {
  if (facts.alreadyEnrolled) return 'already_enrolled';
  if (facts.suppressed) return 'suppressed';
  if (!facts.allowConsumer && isConsumerEmail(prospect.email)) return 'consumer';
  if (prospect.validation === 'invalid' || prospect.validation === 'role' || prospect.validation === 'no_mx') return 'invalid';
  if (facts.enrolledElsewhere) return 'enrolled_elsewhere';
  return null;
}

async function loadCandidates(db: Database, input: AddReachCampaignProspectsInput): Promise<ReachProspectRow[]> {
  const byId = new Map<string, ReachProspectRow>();

  const ids = [...new Set(input.prospectIds ?? [])];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db
      .select()
      .from(reachProspects)
      .where(and(inArray(reachProspects.id, ids.slice(i, i + CHUNK)), isNull(reachProspects.deletedAt)));
    for (const row of rows) byId.set(row.id, row);
  }

  if (input.listId) {
    const rows = await db
      .select({ prospect: reachProspects })
      .from(reachProspectListMembers)
      .innerJoin(reachProspects, eq(reachProspects.id, reachProspectListMembers.prospectId))
      .where(and(eq(reachProspectListMembers.listId, input.listId), isNull(reachProspects.deletedAt)));
    for (const row of rows) byId.set(row.prospect.id, row.prospect);
  }
  return [...byId.values()];
}

export interface AddProspectsResult {
  report: ReachAddProspectsReport;
  addedIds: string[];
}

/** Enroll (as `queued`) every candidate that passes the checks; report the rest by reason. */
export async function addProspectsToCampaign(
  db: Database,
  campaignId: string,
  input: AddReachCampaignProspectsInput,
  options: { allowConsumer: boolean },
): Promise<AddProspectsResult> {
  const candidates = await loadCandidates(db, input);
  const skipped = new Map<SkipReason, number>();
  const bump = (reason: SkipReason) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  if (candidates.length === 0) return { report: { added: 0, skipped: [] }, addedIds: [] };

  const prospectIds = candidates.map((c) => c.id);
  const here = new Set<string>();
  const elsewhere = new Set<string>();
  for (let i = 0; i < prospectIds.length; i += CHUNK) {
    const rows = await db
      .select({ prospectId: reachEnrollments.prospectId, campaignId: reachEnrollments.campaignId, status: reachEnrollments.status })
      .from(reachEnrollments)
      .where(
        and(
          inArray(reachEnrollments.prospectId, prospectIds.slice(i, i + CHUNK)),
          // Already in this campaign (any status), or live in another one.
          sql`(${reachEnrollments.campaignId} = ${campaignId} OR ${reachEnrollments.status} IN ('queued', 'active'))`,
        ),
      );
    for (const row of rows) {
      if (row.campaignId === campaignId) here.add(row.prospectId);
      else elsewhere.add(row.prospectId);
    }
  }

  const suppressed = await loadSuppressionIndex(
    db,
    candidates.map((c) => c.email),
  );

  const eligible: ReachProspectRow[] = [];
  for (const prospect of candidates) {
    const reason = enrollmentSkipReason(prospect, {
      alreadyEnrolled: here.has(prospect.id),
      enrolledElsewhere: elsewhere.has(prospect.id),
      suppressed: suppressed.check(prospect.email) !== null,
      allowConsumer: options.allowConsumer,
    });
    if (reason) bump(reason);
    else eligible.push(prospect);
  }

  const addedIds: string[] = [];
  for (let i = 0; i < eligible.length; i += CHUNK) {
    const inserted = await db
      .insert(reachEnrollments)
      .values(eligible.slice(i, i + CHUNK).map((p) => ({ id: generateId('renr'), campaignId, prospectId: p.id, status: 'queued' as const })))
      .onConflictDoNothing()
      .returning({ id: reachEnrollments.id });
    addedIds.push(...inserted.map((r) => r.id));
  }
  // A concurrent request may have enrolled some of them between the check and the insert.
  const lost = eligible.length - addedIds.length;
  if (lost > 0) skipped.set('already_enrolled', (skipped.get('already_enrolled') ?? 0) + lost);

  return {
    report: {
      added: addedIds.length,
      skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
    },
    addedIds,
  };
}

export function toEnrollment(
  row: ReachEnrollmentRow,
  prospect: Pick<ReachProspectRow, 'id' | 'email' | 'firstName' | 'lastName' | 'companyName'>,
  mailboxEmail: string | null,
): ReachEnrollment {
  return {
    id: row.id,
    campaignId: row.campaignId,
    prospect: {
      id: prospect.id,
      email: prospect.email,
      firstName: prospect.firstName,
      lastName: prospect.lastName,
      companyName: prospect.companyName,
    },
    mailboxId: row.mailboxId,
    mailboxEmail,
    status: row.status,
    currentStep: row.currentStep,
    nextSendAt: row.nextSendAt?.toISOString() ?? null,
    stoppedReason: row.stoppedReason,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Enrollments of a campaign with their prospect and sending mailbox, newest first. */
export async function listCampaignEnrollments(
  db: Database,
  campaignId: string,
  options: { status?: ReachEnrollmentRow['status']; cursorCondition?: SQL; limit: number },
) {
  const conditions = [eq(reachEnrollments.campaignId, campaignId)];
  if (options.status) conditions.push(eq(reachEnrollments.status, options.status));
  if (options.cursorCondition) conditions.push(options.cursorCondition);
  const rows = await db
    .select({ enrollment: reachEnrollments, prospect: reachProspects, mailboxEmail: reachMailboxes.email })
    .from(reachEnrollments)
    .innerJoin(reachProspects, eq(reachProspects.id, reachEnrollments.prospectId))
    .leftJoin(reachMailboxes, eq(reachMailboxes.id, reachEnrollments.mailboxId))
    .where(and(...conditions))
    .orderBy(desc(reachEnrollments.createdAt), desc(reachEnrollments.id))
    .limit(options.limit + 1);
  return rows.map((r) => ({ row: r.enrollment, prospect: r.prospect, mailboxEmail: r.mailboxEmail }));
}

export async function countCampaignEnrollments(
  db: Database,
  campaignId: string,
  status?: ReachEnrollmentRow['status'],
): Promise<number> {
  const conditions = [eq(reachEnrollments.campaignId, campaignId)];
  if (status) conditions.push(eq(reachEnrollments.status, status));
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reachEnrollments)
    .where(and(...conditions));
  return Number(row?.n ?? 0);
}

/** Remove an enrollment (history in `reach_messages` stays). */
export async function removeEnrollment(db: Database, campaignId: string, enrollmentId: string): Promise<ReachEnrollmentRow | null> {
  const [row] = await db
    .delete(reachEnrollments)
    .where(and(eq(reachEnrollments.id, enrollmentId), eq(reachEnrollments.campaignId, campaignId)))
    .returning();
  return row ?? null;
}

/** Mailboxes assigned to a campaign that can send right now (status `active`). */
export async function countActiveCampaignMailboxes(db: Database, campaignId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reachCampaignMailboxes)
    .innerJoin(reachMailboxes, eq(reachMailboxes.id, reachCampaignMailboxes.mailboxId))
    .where(
      and(
        eq(reachCampaignMailboxes.campaignId, campaignId),
        eq(reachMailboxes.status, 'active'),
        isNull(reachMailboxes.deletedAt),
      ),
    );
  return Number(row?.n ?? 0);
}
