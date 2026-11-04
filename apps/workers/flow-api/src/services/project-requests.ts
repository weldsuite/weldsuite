/**
 * Project intake queries and the approval outcome of a request (design:
 * weldflow-delivery-and-portfolio.md, "Intake"; ADR FLOW-016).
 *
 * A request goes to the portfolio board through the approvals core with the
 * subject type `project_request`: every board member has to approve it. This
 * file registers the subject's handler, so the core settles a request as
 * `approved` or `rejected` once the rows add up (a rejection settles it at
 * once). The routes of the approvals inbox are slice A's; they call the core,
 * which calls the handler below.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { registerApprovalSubject, type ResolvedApprovalOutcome } from '@weldsuite/flow-domain/approvals';
import { DEFAULT_SCORING_MODEL, presentProjectRequest } from '@weldsuite/flow-domain/intake';
import type { ScoringCriterionInput } from '@weldsuite/app-api-client/schemas/flow-portfolio';
import type { Env, Variables } from '../types';

const t = schema.projectRequests;
const settingsTable = schema.flowWorkspaceSettings;

export type ProjectRequestRow = typeof t.$inferSelect;
export type NewProjectRequestRow = typeof t.$inferInsert;
export type SettingsRow = typeof settingsTable.$inferSelect;

/** What the board decides on a project request: the rows settle it as approved or rejected. */
registerApprovalSubject('project_request', {
  onResolved: async (db, subjectId, outcome, context) => {
    await settleProjectRequest(db, subjectId, outcome, context.now);
  },
});

/**
 * Settle a request under assessment as the board decided. Only an assessing
 * request moves, so running it again (the core may) changes nothing.
 */
export async function settleProjectRequest(
  db: Database,
  requestId: string,
  outcome: ResolvedApprovalOutcome,
  now: Date,
): Promise<void> {
  await db
    .update(t)
    .set({ status: outcome, updatedAt: now })
    .where(and(eq(t.id, requestId), eq(t.status, 'assessing'), isNull(t.deletedAt)));
}

/**
 * Publish `project_request.approved` or `.rejected` once the approvals core has
 * settled a request. The core's handler has no request context, so the route
 * that answers the review (slice A's `/api/approvals/:id/decide`) calls this
 * when the answer resolved a `project_request` subject.
 */
export async function publishProjectRequestOutcome(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  requestId: string,
  outcome: ResolvedApprovalOutcome,
): Promise<void> {
  const row = await findProjectRequest(c.get('tenantDb'), requestId);
  if (!row) return;
  publishEntityEvent({
    c,
    entityType: 'project_request',
    entityId: row.id,
    action: outcome,
    data: { ...presentProjectRequest(row) },
  });
}

export async function findProjectRequest(db: Database, id: string): Promise<ProjectRequestRow | null> {
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.id, id), isNull(t.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** The workspace's intake settings, or null before it saves any. */
export async function loadSettings(db: Database): Promise<SettingsRow | null> {
  const [row] = await db.select().from(settingsTable).limit(1);
  return row ?? null;
}

/** The scoring model in force: the workspace's, or the default one. */
export function modelOf(settings: SettingsRow | null): ScoringCriterionInput[] {
  return settings ? settings.scoringModel : [...DEFAULT_SCORING_MODEL];
}

/** The portfolio board: the members who approve a request. */
export function boardOf(settings: SettingsRow | null): string[] {
  return settings ? settings.portfolioBoardIds : [];
}
