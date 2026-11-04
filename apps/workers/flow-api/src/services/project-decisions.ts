/**
 * Decision log queries and builders for `/api/project-decisions` (design:
 * weldflow-project-control.md), and the approval subject `decision`: a
 * proposed decision with a named decider asks them through `flow_approvals`
 * (rule `decision`, FLOW-016); an approval makes it decided, a rejection leaves
 * it proposed with the decider's note on the approval row.
 *
 * Registering the subject here (this module is imported by the routes and by
 * `./governance-approvals`) means every flow-api isolate that serves either
 * knows how a decision settles.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { registerApprovalSubject } from '@weldsuite/flow-domain/approvals';
import { decisionCode, decisionResolution } from '@weldsuite/flow-domain/decisions';

const decisions = schema.projectDecisions;

export type DecisionRow = typeof decisions.$inferSelect;
export type NewDecisionRow = typeof decisions.$inferInsert;

/** A live decision by id. */
export async function findDecision(db: Database, id: string): Promise<DecisionRow | null> {
  const [row] = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.id, id), isNull(decisions.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** A decision named by another (the one that replaced it): id, code and title, or null when it is gone. */
export async function findDecisionRef(
  db: Database,
  id: string | null,
): Promise<{ id: string; code: string; title: string } | null> {
  if (!id) return null;
  const [row] = await db
    .select({ id: decisions.id, number: decisions.number, title: decisions.title })
    .from(decisions)
    .where(and(eq(decisions.id, id), isNull(decisions.deletedAt)))
    .limit(1);
  return row ? { id: row.id, code: decisionCode(row.number), title: row.title } : null;
}

/** The live decisions a decision replaced, oldest number first. */
export async function decisionsReplacedBy(
  db: Database,
  id: string,
): Promise<Array<{ id: string; code: string; title: string }>> {
  const rows = await db
    .select({ id: decisions.id, number: decisions.number, title: decisions.title })
    .from(decisions)
    .where(and(eq(decisions.supersededById, id), isNull(decisions.deletedAt)))
    .orderBy(asc(decisions.number));
  return rows.map((row) => ({ id: row.id, code: decisionCode(row.number), title: row.title }));
}

/** The insert values of a new decision. */
export function newDecisionValues(
  input: {
    projectId: string;
    title: string;
    context?: string | null;
    options: Array<{ title: string; note: string | null; chosen: boolean }>;
    consequences?: string[];
    status: 'proposed' | 'decided';
    deciderId?: string | null;
    decisionDueAt?: Date | null;
    decidedBy?: string | null;
    decidedAt?: Date | null;
  },
  ctx: { id: string; number: number; userId: string; now: Date },
): NewDecisionRow {
  const decided = input.status === 'decided';
  return {
    id: ctx.id,
    projectId: input.projectId,
    number: ctx.number,
    title: input.title,
    status: input.status,
    context: input.context ?? null,
    options: input.options,
    consequences: input.consequences ?? [],
    deciderId: decided ? null : (input.deciderId ?? null),
    decisionDueAt: decided ? null : (input.decisionDueAt ?? null),
    decidedBy: decided ? (input.decidedBy ?? ctx.userId) : null,
    decidedAt: decided ? (input.decidedAt ?? ctx.now) : null,
    createdBy: ctx.userId,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

// A named decider's answer settles the decision: approved makes it decided (by
// whoever answered, the decider or their delegate). Idempotent: a decision that
// is no longer proposed is left alone.
registerApprovalSubject('decision', {
  async onResolved(db, subjectId, outcome, context) {
    const row = await findDecision(db, subjectId);
    if (!row || row.status !== 'proposed') return;
    const resolution = decisionResolution(outcome, context.actor?.id ?? null, row.deciderId, context.now);
    if (!resolution) return;
    await db
      .update(decisions)
      .set({
        status: resolution.status,
        decidedBy: resolution.decidedBy,
        decidedAt: resolution.decidedAt,
        updatedAt: context.now,
      })
      .where(and(eq(decisions.id, subjectId), eq(decisions.status, 'proposed'), isNull(decisions.deletedAt)));
  },
});
