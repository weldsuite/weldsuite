/**
 * Deliverable queries and builders for `/api/project-deliverables` (design:
 * weldflow-project-control.md), and the approval subject `deliverable`: a
 * sign-off asks the sponsor and then, optionally, a client contact through
 * `flow_approvals` (rules `deliverable_sponsor` and `deliverable_client`,
 * FLOW-016). Full approval accepts the deliverable, a rejection rejects it.
 *
 * Registering the subject here (this module is imported by the routes and by
 * `./governance-approvals`) means every flow-api isolate that serves either
 * knows how a sign-off settles.
 */

import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { registerApprovalSubject } from '@weldsuite/flow-domain/approvals';
import { deliverableResolution, type DeliverableRaid } from '@weldsuite/flow-domain/deliverables';
import { raidCode } from '@weldsuite/flow-domain/raid';

const deliverables = schema.projectDeliverables;
const links = schema.projectControlLinks;

export type DeliverableRow = typeof deliverables.$inferSelect;
export type NewDeliverableRow = typeof deliverables.$inferInsert;

export interface TaskProgress {
  done: number;
  total: number;
}

/** A live deliverable by id. */
export async function findDeliverable(db: Database, id: string): Promise<DeliverableRow | null> {
  const [row] = await db
    .select()
    .from(deliverables)
    .where(and(eq(deliverables.id, id), isNull(deliverables.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Task progress of deliverables: the live, non-cancelled tasks that count toward
 * each (`tasks.deliverable_id`), and how many of them are done. Computed on
 * read; a deliverable with no task is `{ done: 0, total: 0 }`.
 */
export async function taskProgressForDeliverables(db: Database, ids: string[]): Promise<Map<string, TaskProgress>> {
  const progress = new Map<string, TaskProgress>(ids.map((id) => [id, { done: 0, total: 0 }]));
  if (ids.length === 0) return progress;
  const t = schema.tasks;
  const rows = await db
    .select({
      deliverableId: t.deliverableId,
      total: sql<number>`count(*)`.mapWith(Number),
      done: sql<number>`count(*) filter (where ${t.status} = 'done')`.mapWith(Number),
    })
    .from(t)
    .where(and(inArray(t.deliverableId, ids), isNull(t.deletedAt), ne(t.status, 'cancelled')))
    .groupBy(t.deliverableId);
  for (const row of rows) {
    if (row.deliverableId) progress.set(row.deliverableId, { done: row.done, total: row.total });
  }
  return progress;
}

/**
 * The register items that affect each deliverable (`affects` or `threatens`
 * links from a RAID item), for the Scope table. Oldest link first.
 */
export async function raidForDeliverables(db: Database, ids: string[]): Promise<Map<string, DeliverableRaid[]>> {
  const out = new Map<string, DeliverableRaid[]>(ids.map((id) => [id, []]));
  for (const row of ids.length === 0 ? [] : await raidLinkRows(db, ids)) {
    out.get(row.deliverableId)?.push({ id: row.id, kind: row.kind, code: raidCode(row.kind, row.number), title: row.title });
  }
  return out;
}

async function raidLinkRows(db: Database, ids: string[]) {
  const items = schema.projectRaidItems;
  return db
    .select({
      deliverableId: links.toId,
      id: items.id,
      kind: items.kind,
      number: items.number,
      title: items.title,
    })
    .from(links)
    .innerJoin(items, eq(items.id, links.fromId))
    .where(
      and(
        eq(links.toType, 'deliverable'),
        inArray(links.toId, ids),
        eq(links.fromType, 'raid_item'),
        inArray(links.relation, ['affects', 'threatens']),
        isNull(items.deletedAt),
      ),
    )
    .orderBy(asc(links.createdAt), asc(links.id));
}

/** The insert values of a new deliverable. */
export function newDeliverableValues(
  input: {
    projectId: string;
    title: string;
    description?: string | null;
    ownerId?: string | null;
    status?: 'not_started' | 'in_progress';
    plannedStart: Date | null;
    plannedEnd: Date | null;
    acceptanceCriteria: DeliverableRow['acceptanceCriteria'];
    clientVisible?: boolean;
    position: number;
  },
  ctx: { id: string; number: number; userId: string; now: Date },
): NewDeliverableRow {
  return {
    id: ctx.id,
    projectId: input.projectId,
    number: ctx.number,
    title: input.title,
    description: input.description ?? null,
    ownerId: input.ownerId ?? null,
    status: input.status ?? 'not_started',
    plannedStart: input.plannedStart,
    plannedEnd: input.plannedEnd,
    acceptanceCriteria: input.acceptanceCriteria,
    position: input.position,
    clientVisible: input.clientVisible ?? false,
    createdBy: ctx.userId,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

/** The next position of a project's list: after the last live deliverable. */
export async function nextDeliverablePosition(db: Database, projectId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${deliverables.position}), 0)::int` })
    .from(deliverables)
    .where(and(eq(deliverables.projectId, projectId), isNull(deliverables.deletedAt)));
  return (row?.max ?? 0) + 1;
}

// A sign-off settles by the default rule (every step approved, one rejection
// rejects). Approved: the deliverable is accepted, by whoever gave the answer
// that settled it. Rejected: it is rejected. Idempotent: an accepted deliverable
// is left alone.
registerApprovalSubject('deliverable', {
  async onResolved(db, subjectId, outcome, context) {
    const row = await findDeliverable(db, subjectId);
    if (!row || row.status === 'accepted') return;
    const resolution = deliverableResolution(outcome, context.actor?.id ?? null, context.rows, context.now);
    if (resolution.status === 'accepted') {
      await db
        .update(deliverables)
        .set({
          status: 'accepted',
          acceptedBy: resolution.acceptedBy,
          acceptedAt: resolution.acceptedAt,
          updatedAt: context.now,
        })
        .where(and(eq(deliverables.id, subjectId), ne(deliverables.status, 'accepted'), isNull(deliverables.deletedAt)));
    } else if (row.status !== 'rejected') {
      await db
        .update(deliverables)
        .set({ status: 'rejected', updatedAt: context.now })
        .where(and(eq(deliverables.id, subjectId), ne(deliverables.status, 'accepted'), isNull(deliverables.deletedAt)));
    }
  },
});
