/**
 * Closing a project: /api/project-close/* (design: weldflow-delivery-and-portfolio.md,
 * "Close a project"; slice F).
 *
 *   GET  /:projectId            the close checklist, computed from the project's tables
 *   POST /:projectId/handover   new owners for open RAID items and for benefits
 *   POST /:projectId/request    ask the sponsor to sign the project off (approval subject
 *                               `project_close`, rule `close`)
 *
 * The sponsor answers through My reviews (`/api/approvals`); an approval sets
 * `projects.status = 'Closed'` (`services/project-closing.ts`).
 *
 * Permissions: projects:read | projects:update, plus the project membership
 * boundary (FLOW-001): the checklist is for members, handing over and asking
 * for sign-off for project managers. Final cost amounts need `projects:finance`
 * or a manager; others see the percentage only. The checks run in a fixed order
 * so every backend answers alike: permission, then the project (404), then
 * project access (403), then the body (400), then the rules.
 */

import { Hono } from 'hono';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { error, success } from '@weldsuite/worker-kit/response';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { handoverSchema, requestCloseSchema } from '@weldsuite/app-api-client/schemas/project-closing';
import { cancelPendingApprovals, listSubjectApprovals, requestApprovals, sponsorOf } from '@weldsuite/flow-domain/approvals';
import { CLOSING_MESSAGES } from '@weldsuite/flow-domain/project-closing';
import { raidEventData } from '@weldsuite/flow-domain/raid';
import type { Env, Variables } from '../../types';
import { canAccessProject, canManageProject } from '../../lib/project-access';
import { projectAnalyticsPayload } from '../../lib/weldflow-analytics-payload';
import { PROJECT_DENIED, PROJECT_MANAGE_DENIED, parseBody, type AppContext } from '../../lib/closing-input';
import { findLiveProject, loadChecklist } from '../../services/project-closing';
import { announceApprovalsCancelled, announceApprovalsRequested } from '../../services/approvals';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Final cost amounts are for managers and for members with `projects:finance`; others see percentages only. */
async function amountsVisible(c: AppContext, projectId: string): Promise<boolean> {
  return (await canManageProject(c, projectId)) || (await hasContextPermission(c, 'projects:finance'));
}

// ── The checklist ───────────────────────────────────────────────────────────

app.get('/:projectId', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  try {
    const project = await findLiveProject(db, projectId);
    if (!project) return error.notFound(c, 'Project', projectId);
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
    return success(c, await loadChecklist(db, project, { amountsVisible: await amountsVisible(c, projectId) }));
  } catch (err) {
    console.error('[flow-api/project-close] checklist failed:', err);
    return error.internal(c, 'Failed to load the close checklist');
  }
});

// ── Hand over ───────────────────────────────────────────────────────────────

/** The live, open register items of a project among `ids`. */
async function openRaidItems(db: Database, projectId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(schema.projectRaidItems)
    .where(
      and(
        inArray(schema.projectRaidItems.id, ids),
        eq(schema.projectRaidItems.projectId, projectId),
        isNull(schema.projectRaidItems.deletedAt),
        isNull(schema.projectRaidItems.closedAt),
      ),
    );
}

/** The live, not yet closed benefits of a project among `ids`. */
async function openBenefits(db: Database, projectId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(schema.projectBenefits)
    .where(
      and(
        inArray(schema.projectBenefits.id, ids),
        eq(schema.projectBenefits.projectId, projectId),
        isNull(schema.projectBenefits.deletedAt),
        ne(schema.projectBenefits.status, 'closed'),
      ),
    );
}

/** In the order the request named them; an owner that did not change publishes nothing. */
function publishHandoverEvents(
  c: AppContext,
  handover: {
    projectId: string;
    now: Date;
    raidRows: Awaited<ReturnType<typeof openRaidItems>>;
    raidOwner: ReadonlyMap<string, string>;
    benefitRows: Awaited<ReturnType<typeof openBenefits>>;
    benefitOwner: ReadonlyMap<string, string>;
  },
): void {
  const { projectId, now } = handover;
  const raidBefore = new Map(handover.raidRows.map((row) => [row.id, row]));
  for (const [id, ownerId] of handover.raidOwner) {
    const before = raidBefore.get(id);
    if (!before || ownerId === before.ownerId) continue;
    publishEntityEvent({
      c,
      entityType: 'project_raid_item',
      entityId: id,
      action: 'updated',
      data: raidEventData({ ...before, ownerId, updatedAt: now }),
    });
  }
  const benefitBefore = new Map(handover.benefitRows.map((row) => [row.id, row]));
  for (const [id, ownerId] of handover.benefitOwner) {
    const before = benefitBefore.get(id);
    if (!before || ownerId === before.ownerId) continue;
    publishEntityEvent({
      c,
      entityType: 'project_benefit',
      entityId: id,
      action: 'updated',
      data: {
        id,
        projectId,
        number: before.number,
        code: `B-${before.number}`,
        title: before.title,
        status: before.status,
        ownerId,
      },
    });
  }
}

app.post('/:projectId/handover', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  const project = await findLiveProject(db, projectId);
  if (!project) return error.notFound(c, 'Project', projectId);
  if (!(await canManageProject(c, projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  const body = await parseBody(c, handoverSchema);
  if (!body.ok) return body.response;
  const raidEntries = body.data.raidItems ?? [];
  const benefitEntries = body.data.benefits ?? [];
  if (raidEntries.length + benefitEntries.length === 0) return error.badRequest(c, CLOSING_MESSAGES.nothingToHandOver);

  try {
    // Every item has to be a live, open item of this project.
    const raidIds = [...new Set(raidEntries.map((entry) => entry.id))];
    const raidRows = await openRaidItems(db, projectId, raidIds);
    if (raidRows.length !== raidIds.length) return error.badRequest(c, CLOSING_MESSAGES.handoverRaidItem);
    const benefitIds = [...new Set(benefitEntries.map((entry) => entry.id))];
    const benefitRows = await openBenefits(db, projectId, benefitIds);
    if (benefitRows.length !== benefitIds.length) return error.badRequest(c, CLOSING_MESSAGES.handoverBenefit);

    // The last entry for an item wins.
    const raidOwner = new Map(raidEntries.map((entry) => [entry.id, entry.ownerId]));
    const benefitOwner = new Map(benefitEntries.map((entry) => [entry.id, entry.ownerId]));
    const now = new Date();
    const handovers = { ...(project.settings?.closing?.handovers ?? {}) };
    for (const [id, ownerId] of raidOwner) handovers[id] = { ownerId, by: userId, at: now.toISOString() };

    await atomically(db, (handle) => [
      ...[...raidOwner].map(([id, ownerId]) =>
        handle
          .update(schema.projectRaidItems)
          .set({ ownerId, updatedAt: now })
          .where(and(eq(schema.projectRaidItems.id, id), isNull(schema.projectRaidItems.deletedAt))),
      ),
      ...[...benefitOwner].map(([id, ownerId]) =>
        handle
          .update(schema.projectBenefits)
          .set({ ownerId, updatedAt: now })
          .where(and(eq(schema.projectBenefits.id, id), isNull(schema.projectBenefits.deletedAt))),
      ),
      // Merge, never replace: only the `closing` key of the settings is written.
      ...(raidOwner.size > 0
        ? [
            handle
              .update(schema.projects)
              .set({
                settings: sql`coalesce(${schema.projects.settings}, '{}'::jsonb) || jsonb_build_object('closing', ${JSON.stringify({ handovers })}::jsonb)`,
                updatedAt: now,
              })
              .where(eq(schema.projects.id, projectId)),
          ]
        : []),
    ]);

    publishHandoverEvents(c, { projectId, now, raidRows, raidOwner, benefitRows, benefitOwner });
    if (raidOwner.size > 0) {
      const updated = await findLiveProject(db, projectId);
      if (updated) {
        publishEntityEvent({
          c,
          entityType: 'project',
          entityId: projectId,
          action: 'updated',
          data: projectAnalyticsPayload(updated as unknown as Record<string, unknown>),
        });
      }
    }

    const fresh = await findLiveProject(db, projectId);
    if (!fresh) return error.notFound(c, 'Project', projectId);
    return success(c, await loadChecklist(db, fresh, { amountsVisible: true }));
  } catch (err) {
    console.error('[flow-api/project-close] handover failed:', err);
    return error.internal(c, 'Failed to hand over the items');
  }
});

// ── Request sign-off ────────────────────────────────────────────────────────

app.post('/:projectId/request', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  const project = await findLiveProject(db, projectId);
  if (!project) return error.notFound(c, 'Project', projectId);
  if (!(await canManageProject(c, projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  const body = await parseBody(c, requestCloseSchema);
  if (!body.ok) return body.response;

  try {
    if (project.status === 'Closed') return error.conflict(c, CLOSING_MESSAGES.alreadyClosed);
    const checklist = await loadChecklist(db, project, { amountsVisible: true });
    if (checklist.signOff.state === 'pending') return error.conflict(c, CLOSING_MESSAGES.alreadyRequested);
    if (!checklist.canRequest) return error.conflict(c, CLOSING_MESSAGES.checklistOpen);
    const sponsor = sponsorOf(project.settings, project.projectManagerId);
    if (!sponsor) return error.badRequest(c, CLOSING_MESSAGES.noSponsor);

    // A request the sponsor declined starts over from scratch.
    const earlier = await listSubjectApprovals(db, 'project_close', projectId);
    if (earlier.length > 0) {
      announceApprovalsCancelled(c, await cancelPendingApprovals(db, { subjectType: 'project_close', subjectId: projectId, includeDecided: true }));
    }
    const requested = await requestApprovals(db, {
      projectId,
      subjectType: 'project_close',
      subjectId: projectId,
      requestedBy: userId,
      rows: [{ approverId: sponsor, roleLabel: 'Sponsor', rule: { code: 'close' } }],
    });
    if (!requested.ok) return error.conflict(c, requested.message);

    announceApprovalsRequested(c, {
      rows: requested.rows,
      subject: { code: null, title: `Close ${project.name}` },
      projectName: project.name,
    });
    return success(c, await loadChecklist(db, project, { amountsVisible: true }), 201);
  } catch (err) {
    console.error('[flow-api/project-close] request failed:', err);
    return error.internal(c, 'Failed to request sign-off');
  }
});

export const projectCloseRoutes = app;
