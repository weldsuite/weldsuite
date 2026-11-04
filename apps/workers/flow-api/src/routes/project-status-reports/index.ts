/**
 * Status report routes: /api/project-status-reports/*, backed by
 * `project_status_reports` (design: weldflow-delivery-and-portfolio.md; ADR
 * FLOW-018).
 *
 *   GET    /                    list of a project's reports (projectId required, cursor)
 *   GET    /settings/:projectId the schedule (`statusReport`) and the risk appetite
 *   PUT    /settings/:projectId merge-write them into `projects.settings`
 *   GET    /:id                 report, with who it goes to
 *   POST   /                    draft a report for a period, computed from project data
 *   PATCH  /:id                 edit a draft: summary, overrides with a reason, lists, recipients
 *   POST   /:id/refresh         recompute the data of a draft, keep what the project manager wrote
 *   POST   /:id/publish         freeze into the snapshot, set the project's health, send
 *   DELETE /:id                 discard a draft
 *
 * Permissions: projects:read for reads, projects:update for every write, plus
 * the project membership boundary (FLOW-001): reading takes membership,
 * writing takes managing the project (the project manager, an owner/admin
 * member, or projects:scope:all). The checks run in a fixed order so every
 * backend answers alike: permission, then the report (404), then project
 * access (403), then the body (400), then the business rules.
 *
 * A published report is never edited: a correction is a new report for the
 * same period, which supersedes it.
 */

import { Hono } from 'hono';
import type { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import {
  createStatusReportSchema,
  listStatusReportsQuerySchema,
  putStatusReportSettingsSchema,
  updateStatusReportSchema,
  type StatusReportSettingsResponse,
} from '@weldsuite/app-api-client/schemas/project-reporting';
import {
  OVERALL_REQUIRED,
  PERIOD_DRAFT_EXISTS,
  PUBLISHED_IMMUTABLE,
  SUMMARY_REQUIRED,
  defaultPeriod,
  healthForColour,
  mergeAreas,
  mergeItems,
  mergeOverall,
  nextSlotAfter,
  presentStatusReport,
  presentStatusReportSummary,
  snapshotComputedAreas,
  statusReportEventData,
  storedItem,
  windowDays,
} from '@weldsuite/flow-domain/status-report';
import type { Env, Variables } from '../../types';
import { canAccessProject, canManageProject } from '../../lib/project-access';
import { parseLimit } from '../../lib/query-params';
import { parseBody, readQuery, type AppContext } from '../../lib/reporting-request';
import { projectAnalyticsPayload } from '../../lib/weldflow-analytics-payload';
import { sendPublishedReport } from '../../lib/report-notifications';
import { stakeholdersOfProject } from '../../services/stakeholders';
import {
  computeReport,
  findReport,
  insertDraft,
  loadReportProject,
  presentTarget,
  reportsOfPeriod,
  riskAppetiteOf,
  scheduleOf,
  supersededByMap,
  targetsOf,
  type ReportProject,
  type StatusReportRow,
} from '../../services/status-reports';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectStatusReports;

const PROJECT_DENIED = 'You are not a member of this project';
const PROJECT_MANAGE_DENIED = 'You do not have manage access to this project';
const REPORT_LABEL = 'Status report';
const RECIPIENT_NOT_FOUND = 'Recipient not found in this project';
const ALREADY_PUBLISHED = 'This report is already published';

// ── Helpers ─────────────────────────────────────────────────────────────────

function publishReport(c: AppContext, action: 'created' | 'updated' | 'deleted' | 'published', row: StatusReportRow) {
  publishEntityEvent({
    c,
    entityType: 'project_status_report',
    entityId: row.id,
    action,
    data: statusReportEventData(row),
  });
}

/** The report as every route answers it: with who it goes to (a draft) or went to (a published one). */
async function presentOne(c: AppContext, row: StatusReportRow, project: ReportProject | null) {
  const db = c.get('tenantDb');
  const superseding = await supersededByMap(db, [row.id]);
  let recipients;
  if (row.status === 'published') {
    // Frozen at publication: names as they were, never the addresses.
    const frozen = (row.snapshot?.recipients ?? []) as Array<{ stakeholderId: string | null; userId: string | null; name: string | null; kind: 'member' | 'contact' }>;
    recipients = frozen.map((entry) => ({ stakeholderId: entry.stakeholderId ?? null, userId: entry.userId ?? null, name: entry.name ?? null, email: null, kind: entry.kind }));
  } else {
    recipients = project ? (await targetsOf(db, project, row.recipients)).map(presentTarget) : [];
  }
  return presentStatusReport(row, superseding.get(row.id) ?? null, recipients);
}

/** The stakeholder ids that are not live entries of the project's register. */
async function unknownRecipients(c: AppContext, projectId: string, ids: readonly string[] | undefined): Promise<boolean> {
  if (!ids || ids.length === 0) return false;
  const register = new Set((await stakeholdersOfProject(c.get('tenantDb'), projectId)).map((row) => row.id));
  return ids.some((id) => !register.has(id));
}

function settingsResponse(project: ReportProject, now: Date): StatusReportSettingsResponse {
  const schedule = scheduleOf(project);
  return {
    projectId: project.id,
    statusReport: schedule,
    riskAppetite: riskAppetiteOf(project),
    nextDraftAt: schedule ? nextSlotAfter(schedule, now).toISOString() : null,
  };
}

// ── Settings ────────────────────────────────────────────────────────────────

// MUST be before /:id.
app.get('/settings/:projectId', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  try {
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
    const project = await loadReportProject(db, projectId);
    if (!project) return error.notFound(c, 'Project', projectId);
    return success(c, settingsResponse(project, new Date()));
  } catch (err) {
    console.error('[flow-api/project-status-reports] settings failed:', err);
    return error.internal(c, 'Failed to load the status report settings');
  }
});

/** A merge write of only the keys sent: `settings` carries other features' keys. */
function mergedSettings(input: z.infer<typeof putStatusReportSettingsSchema>) {
  const patch: Record<string, unknown> = {};
  if (input.statusReport) patch.statusReport = input.statusReport;
  if (input.riskAppetite !== undefined) patch.riskAppetite = input.riskAppetite;
  let merged = sql`coalesce(${schema.projects.settings}, '{}'::jsonb)`;
  if (input.statusReport === null) merged = sql`(${merged} - 'statusReport')`;
  if (Object.keys(patch).length > 0) merged = sql`(${merged} || ${JSON.stringify(patch)}::jsonb)`;
  return merged;
}

app.put('/settings/:projectId', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  const project = await loadReportProject(db, projectId);
  if (!project) return error.notFound(c, 'Project', projectId);
  if (!(await canManageProject(c, projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  const body = await parseBody(c, putStatusReportSettingsSchema);
  if (!body.ok) return body.response;
  const input = body.data;
  if (input.statusReport && (await unknownRecipients(c, projectId, input.statusReport.recipients.stakeholderIds))) {
    return error.badRequest(c, RECIPIENT_NOT_FOUND);
  }

  try {
    const merged = mergedSettings(input);
    const touched = input.statusReport !== undefined || input.riskAppetite !== undefined;
    const now = new Date();
    if (touched) {
      await db.update(schema.projects).set({ settings: merged, updatedAt: now }).where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
    }
    const row = await loadReportProject(db, projectId);
    if (!row) return error.notFound(c, 'Project', projectId);

    if (touched) {
      const [full] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
      publishEntityEvent({
        c,
        entityType: 'project',
        entityId: projectId,
        action: 'updated',
        data: projectAnalyticsPayload((full ?? { id: projectId, name: project.name }) as Record<string, unknown>),
      });
      // The sweep looks at this workspace at its next tick: a draft may already be due.
      if (input.statusReport && c.env.SCHEDULE_INDEX) {
        c.executionCtx.waitUntil(markWorkspaceDue(c.env.SCHEDULE_INDEX, 'status_report_due', c.get('clerkOrgId'), now));
      }
    }
    return success(c, settingsResponse(row, now));
  } catch (err) {
    console.error('[flow-api/project-status-reports] settings update failed:', err);
    return error.internal(c, 'Failed to update the status report settings');
  }
});

// ── Reads ───────────────────────────────────────────────────────────────────

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, listStatusReportsQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  const limit = parseLimit(q.limit, 25, 100);
  if (!(await canAccessProject(c, q.projectId))) return error.forbidden(c, PROJECT_DENIED);

  const conditions = [isNull(t.deletedAt), eq(t.projectId, q.projectId)];
  if (q.status) conditions.push(eq(t.status, q.status));
  const countWhere = and(...conditions);
  if (q.cursor) {
    const [cur] = await db.select({ createdAt: t.createdAt, id: t.id }).from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur) conditions.push(sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`);
  }

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(and(...conditions)).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const superseding = await supersededByMap(db, data.map((row) => row.id));
    return list(
      c,
      data.map((row) => presentStatusReportSummary(row, superseding.get(row.id) ?? null)),
      cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor),
    );
  } catch (err) {
    console.error('[flow-api/project-status-reports] list failed:', err);
    return error.internal(c, 'Failed to list status reports');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await findReport(db, id);
    if (!row) return error.notFound(c, REPORT_LABEL, id);
    if (!(await canAccessProject(c, row.projectId))) return error.forbidden(c, PROJECT_DENIED);
    const project = await loadReportProject(db, row.projectId);
    return success(c, await presentOne(c, row, project));
  } catch (err) {
    console.error('[flow-api/project-status-reports] get failed:', err);
    return error.internal(c, 'Failed to fetch status report');
  }
});

// ── Create ──────────────────────────────────────────────────────────────────

app.post('/', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createStatusReportSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  if (!(await canManageProject(c, input.projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  const project = await loadReportProject(db, input.projectId);
  if (!project) return error.notFound(c, 'Project', input.projectId);

  try {
    const now = new Date();
    const schedule = scheduleOf(project);
    const period = input.period ?? defaultPeriod(schedule, now);
    const existing = await reportsOfPeriod(db, project.id, period);
    if (existing.some((row) => row.status === 'draft')) return error.conflict(c, PERIOD_DRAFT_EXISTS);
    // A new report for a period that has a published one corrects it.
    const superseded = existing.find((row) => row.status === 'published') ?? null;

    const row = await insertDraft(db, project, { period, now, createdBy: userId, supersedes: superseded });
    if (!row) return error.internal(c, 'Failed to create status report');

    publishReport(c, 'created', row);
    return success(c, await presentOne(c, row, project), 201);
  } catch (err) {
    console.error('[flow-api/project-status-reports] create failed:', err);
    return error.internal(c, 'Failed to create status report');
  }
});

// ── Edit a draft ────────────────────────────────────────────────────────────

type UpdateReportInput = z.infer<typeof updateStatusReportSchema>;

/** The areas after an edit: an override sets one by hand, no override hands it back to the computed colour. */
function editedAreas(existing: StatusReportRow, edits: NonNullable<UpdateReportInput['areas']>): StatusReportRow['areas'] {
  const computed = snapshotComputedAreas(existing.snapshot);
  const areas = existing.areas.map((area) => ({ ...area }));
  for (const edit of edits) {
    const index = areas.findIndex((area) => area.key === edit.key);
    if (index === -1) continue;
    areas[index] = edit.override
      ? { key: edit.key, colour: edit.override.colour, reason: edit.override.reason, auto: false }
      : { key: edit.key, colour: computed?.[edit.key]?.colour ?? areas[index].colour, reason: null, auto: true };
  }
  return areas;
}

function editedRecipients(recipients: NonNullable<UpdateReportInput['recipients']> | null): Partial<typeof t.$inferInsert>['recipients'] {
  if (recipients === null) return null;
  return recipients.stakeholderIds ? { stakeholderIds: recipients.stakeholderIds } : {};
}

/** The columns an edit sets: only the fields it sent. */
function reportUpdateSet(existing: StatusReportRow, input: UpdateReportInput, now: Date): Partial<typeof t.$inferInsert> {
  const set: Partial<typeof t.$inferInsert> = { updatedAt: now };
  if (input.summary !== undefined) set.summary = input.summary ? input.summary : null;
  if (input.overall !== undefined) set.overall = input.overall;
  if (input.areas !== undefined) set.areas = editedAreas(existing, input.areas);
  if (input.done !== undefined) set.done = input.done.map(storedItem);
  if (input.next !== undefined) set.next = input.next.map(storedItem);
  if (input.clientVisible !== undefined) set.clientVisible = input.clientVisible;
  if (input.recipients !== undefined) set.recipients = editedRecipients(input.recipients);
  return set;
}

app.patch('/:id', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findReport(db, id);
  if (!existing) return error.notFound(c, REPORT_LABEL, id);
  if (!(await canManageProject(c, existing.projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  const body = await parseBody(c, updateStatusReportSchema);
  if (!body.ok) return body.response;
  const input = body.data;
  if (existing.status === 'published') return error.conflict(c, PUBLISHED_IMMUTABLE);
  if (input.recipients && (await unknownRecipients(c, existing.projectId, input.recipients.stakeholderIds))) {
    return error.badRequest(c, RECIPIENT_NOT_FOUND);
  }

  try {
    const now = new Date();
    const set = reportUpdateSet(existing, input, now);
    await db.update(t).set(set).where(and(eq(t.id, id), isNull(t.deletedAt), eq(t.status, 'draft')));
    const row = await findReport(db, id);
    if (!row) return error.notFound(c, REPORT_LABEL, id);

    publishReport(c, 'updated', row);
    return success(c, await presentOne(c, row, await loadReportProject(db, row.projectId)));
  } catch (err) {
    console.error('[flow-api/project-status-reports] update failed:', err);
    return error.internal(c, 'Failed to update status report');
  }
});

// ── Refresh ─────────────────────────────────────────────────────────────────

app.post('/:id/refresh', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findReport(db, id);
  if (!existing) return error.notFound(c, REPORT_LABEL, id);
  if (!(await canManageProject(c, existing.projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  if (existing.status === 'published') return error.conflict(c, PUBLISHED_IMMUTABLE);
  const project = await loadReportProject(db, existing.projectId);
  if (!project) return error.notFound(c, 'Project', existing.projectId);

  try {
    const now = new Date();
    const computed = await computeReport(db, project, now, windowDays(existing.period, scheduleOf(project)?.cadence ?? null));
    const previous = (existing.snapshot?.computed as { overall?: typeof computed.overall } | undefined)?.overall ?? null;
    await db
      .update(t)
      .set({
        areas: mergeAreas(existing.areas, computed.areas),
        overall: mergeOverall(existing.overall ?? null, previous, computed.overall),
        done: mergeItems(existing.done, computed.done),
        next: mergeItems(existing.next, computed.next),
        snapshot: computed.snapshot,
        updatedAt: now,
      })
      .where(and(eq(t.id, id), isNull(t.deletedAt), eq(t.status, 'draft')));
    const row = await findReport(db, id);
    if (!row) return error.notFound(c, REPORT_LABEL, id);

    publishReport(c, 'updated', row);
    return success(c, await presentOne(c, row, project));
  } catch (err) {
    console.error('[flow-api/project-status-reports] refresh failed:', err);
    return error.internal(c, 'Failed to refresh status report');
  }
});

// ── Publish ─────────────────────────────────────────────────────────────────

app.post('/:id/publish', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await findReport(db, id);
  if (!existing) return error.notFound(c, REPORT_LABEL, id);
  if (!(await canManageProject(c, existing.projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  if (existing.status === 'published') return error.conflict(c, ALREADY_PUBLISHED);
  const project = await loadReportProject(db, existing.projectId);
  if (!project) return error.notFound(c, 'Project', existing.projectId);
  if (!existing.summary || existing.summary.trim() === '') return error.badRequest(c, SUMMARY_REQUIRED);
  if (!existing.overall || existing.overall === 'grey') return error.badRequest(c, OVERALL_REQUIRED);

  try {
    const now = new Date();
    const targets = await targetsOf(db, project, existing.recipients);
    // Everything the report shows, as it stands now: a published row is never edited.
    const frozen: schema.StatusReportSnapshot = {
      ...(existing.snapshot ?? { version: 1 }),
      overall: existing.overall,
      areas: existing.areas,
      summary: existing.summary,
      done: existing.done,
      next: existing.next,
      clientVisible: existing.clientVisible,
      recipients: targets.map((target) => ({ stakeholderId: target.stakeholderId, userId: target.userId, name: target.name, kind: target.kind })),
    };
    const health = healthForColour(existing.overall);
    await atomically(db, (handle) => [
      handle
        .update(t)
        .set({ status: 'published', publishedBy: userId, publishedAt: now, snapshot: frozen, updatedAt: now })
        .where(and(eq(t.id, id), isNull(t.deletedAt), eq(t.status, 'draft'))),
      ...(health
        ? [handle.update(schema.projects).set({ health, updatedAt: now }).where(and(eq(schema.projects.id, project.id), isNull(schema.projects.deletedAt)))]
        : []),
    ]);
    const row = await findReport(db, id);
    if (!row) return error.notFound(c, REPORT_LABEL, id);

    publishReport(c, 'published', row);
    if (health) {
      const [full] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)).limit(1);
      publishEntityEvent({
        c,
        entityType: 'project',
        entityId: project.id,
        action: 'updated',
        data: projectAnalyticsPayload((full ?? { id: project.id, name: project.name, health }) as Record<string, unknown>),
      });
    }

    // Send after the response: members get the in-app notification and the email, client contacts the email.
    const contactIds = new Map<string, string>();
    const register = await stakeholdersOfProject(db, project.id);
    for (const entry of register) if (entry.crmContactId) contactIds.set(entry.id, entry.crmContactId);
    c.executionCtx.waitUntil(
      sendPublishedReport(
        { env: c.env, db, workspaceId: c.get('workspaceId'), clerkOrgId: c.get('clerkOrgId'), actorId: userId },
        { report: row, project, targets, contactIds },
      ).catch((err) => console.error('[flow-api/project-status-reports] sending failed:', err)),
    );
    return success(c, await presentOne(c, row, project));
  } catch (err) {
    console.error('[flow-api/project-status-reports] publish failed:', err);
    return error.internal(c, 'Failed to publish status report');
  }
});

// ── Delete a draft ──────────────────────────────────────────────────────────

app.delete('/:id', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await findReport(db, id);
    if (!existing) return error.notFound(c, REPORT_LABEL, id);
    if (!(await canManageProject(c, existing.projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
    if (existing.status === 'published') return error.conflict(c, PUBLISHED_IMMUTABLE);

    const now = new Date();
    await db.update(t).set({ deletedAt: now, updatedAt: now }).where(and(eq(t.id, id), isNull(t.deletedAt), eq(t.status, 'draft')));
    publishReport(c, 'deleted', { ...existing, deletedAt: now, updatedAt: now });
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/project-status-reports] delete failed:', err);
    return error.internal(c, 'Failed to delete status report');
  }
});

export const projectStatusReportsRoutes = app;
