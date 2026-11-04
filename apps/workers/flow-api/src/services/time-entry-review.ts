/**
 * Approving and rejecting a time entry: shared by `PATCH /api/time-entries/:id/approve`
 * and `/reject`, and by My reviews (`POST /api/approvals/:id/decide` on a pending
 * time entry), so both answer the same way (FLOW-016: time entries keep their
 * own status and stay a second source in the inbox).
 */

import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { hasContextPermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../types';
import { canManageProject } from '../lib/project-access';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type TimeEntryRow = typeof schema.timeEntries.$inferSelect;

export type TimeEntryReviewStatus = 'approved' | 'rejected';

/**
 * Who may approve or reject an entry: whoever manages its project (project
 * manager, owner/admin member, `projects:scope:all`), or a `projects:scope:all`
 * holder for an entry that is not tied to a project. Never the entry's own
 * author, so nobody signs off their own hours.
 */
export async function reviewDenial(c: Ctx, entry: TimeEntryRow): Promise<string | null> {
  if (entry.userId === c.get('userId')) return 'You cannot approve or reject your own time entry';
  const allowed = entry.projectId
    ? await canManageProject(c, entry.projectId)
    : await hasContextPermission(c, 'projects:scope:all');
  return allowed ? null : 'Only a project manager can approve or reject time entries';
}

/** Write the review status and publish the entry's two entity events (`project_time_entry.updated`, `project_timesheet.<status>`). */
export async function applyTimeEntryReview(c: Ctx, entry: TimeEntryRow, status: TimeEntryReviewStatus): Promise<void> {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const now = new Date();
  await db
    .update(schema.timeEntries)
    .set(
      status === 'approved'
        ? { status, approvedBy: userId ?? null, approvedAt: now, updatedAt: now }
        : // Rejecting also withdraws an earlier approval, which unlocks the entry for its owner.
          { status, approvedBy: null, approvedAt: null, updatedAt: now },
    )
    .where(eq(schema.timeEntries.id, entry.id));

  const payload = {
    id: entry.id,
    projectId: entry.projectId,
    taskId: entry.taskId,
    userId: entry.userId,
    duration: Number(entry.duration),
  };
  publishEntityEvent({
    c,
    entityType: 'project_time_entry',
    entityId: entry.id,
    action: 'updated',
    data: payload,
  });
  publishEntityEvent({
    c,
    entityType: 'project_timesheet',
    entityId: entry.id,
    action: status,
    data: { ...payload, reviewedBy: userId ?? null },
  });
}
