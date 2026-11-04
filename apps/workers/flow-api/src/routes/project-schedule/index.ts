/**
 * /api/project-schedule: the computed schedule and the impact of a move
 * (design: weldflow-delivery-and-portfolio.md, "Schedule and critical path";
 * ADR FLOW-015).
 *
 *   GET  /settings/:projectId   the project calendar and the auto-schedule switch
 *   PUT  /settings/:projectId   merge-write `settings.schedule`
 *   GET  /:projectId            early and late dates, float, critical path, conflicts
 *   POST /:projectId/preview    {taskId, startDate?, dueDate?}: what a move would do
 *   POST /:projectId/apply      the same move, written (auto-schedule on): the task
 *                               and every dependent it pushes, in one batch
 *
 * Permissions: projects:read for the reads and the preview, projects:update to
 * write, plus the project membership boundary (FLOW-001): reads need a member,
 * `apply` a member who can write, settings a project manager. The checks run
 * in a fixed order so every backend answers alike: permission, then the project
 * (404), then project access (403), then the body (400), then the rules.
 */

import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { error, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import { scheduleMoveSchema, updateScheduleSettingsSchema } from '@weldsuite/app-api-client/schemas/project-schedule';
import { computeSchedule, dayNumber, normalizeCalendar, previewMove, withTimeOfDay } from '@weldsuite/flow-domain/schedule';
import type { Env, Variables } from '../../types';
import { canAccessProject, canManageProject, canWriteProject } from '../../lib/project-access';
import {
  PROJECT_DENIED,
  PROJECT_MANAGE_DENIED,
  PROJECT_WRITE_DENIED,
  parseBody,
  type ScheduleContext,
} from '../../lib/schedule-request';
import { projectAnalyticsPayload, taskAnalyticsPayload } from '../../lib/weldflow-analytics-payload';
import {
  buildScheduleInput,
  findLiveProject,
  loadScheduleData,
  presentMoveImpact,
  presentProjectSchedule,
  scheduleSettingsOf,
} from '../../services/project-schedule';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const tasks = schema.tasks;

const AUTO_SCHEDULE_OFF = 'Auto-schedule is off for this project';
const HOLIDAYS_INVALID = 'Holidays must be real dates in the form YYYY-MM-DD';

/** The 400 / 404 / 409 of a refused move. */
function moveRefusal(c: ScheduleContext, taskId: string, failure: { code: string; message: string }): Response {
  if (failure.code === 'task_not_found') return error.notFound(c, 'Task', taskId);
  if (failure.code === 'task_closed') return error.conflict(c, failure.message);
  return error.badRequest(c, failure.message);
}

// ── Settings ────────────────────────────────────────────────────────────────

// MUST be before /:projectId.
app.get('/settings/:projectId', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  try {
    const project = await findLiveProject(db, projectId);
    if (!project) return error.notFound(c, 'Project', projectId);
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
    return success(c, scheduleSettingsOf(project.settings));
  } catch (err) {
    console.error('[flow-api/project-schedule] settings failed:', err);
    return error.internal(c, 'Failed to load the schedule settings');
  }
});

app.put('/settings/:projectId', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  const project = await findLiveProject(db, projectId);
  if (!project) return error.notFound(c, 'Project', projectId);
  if (!(await canManageProject(c, projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  const body = await parseBody(c, updateScheduleSettingsSchema);
  if (!body.ok) return body.response;
  if (body.data.holidays?.some((holiday) => dayNumber(holiday) === null)) return error.badRequest(c, HOLIDAYS_INVALID);

  try {
    const current = scheduleSettingsOf(project.settings);
    const calendar = normalizeCalendar({
      workingDays: body.data.workingDays ?? current.workingDays,
      holidays: body.data.holidays ?? current.holidays,
    });
    const next = { ...calendar, autoSchedule: body.data.autoSchedule ?? current.autoSchedule };
    // A merge of this key only: the other settings keys are other features'.
    await atomically(db, (handle) => [
      handle
        .update(schema.projects)
        .set({
          settings: sql`coalesce(${schema.projects.settings}, '{}'::jsonb) || jsonb_build_object('schedule', ${JSON.stringify(next)}::jsonb)`,
          updatedAt: new Date(),
        })
        .where(eq(schema.projects.id, projectId)),
    ]);
    publishEntityEvent({
      c,
      entityType: 'project',
      entityId: projectId,
      action: 'updated',
      data: projectAnalyticsPayload(project as Record<string, unknown>),
    });
    return success(c, next);
  } catch (err) {
    console.error('[flow-api/project-schedule] settings update failed:', err);
    return error.internal(c, 'Failed to update the schedule settings');
  }
});

// ── The schedule ────────────────────────────────────────────────────────────

app.get('/:projectId', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  try {
    const project = await findLiveProject(db, projectId);
    if (!project) return error.notFound(c, 'Project', projectId);
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
    const data = await loadScheduleData(db, project);
    return success(c, presentProjectSchedule(data, computeSchedule(buildScheduleInput(data))));
  } catch (err) {
    console.error('[flow-api/project-schedule] get failed:', err);
    return error.internal(c, 'Failed to compute the schedule');
  }
});

// ── Preview ─────────────────────────────────────────────────────────────────

app.post('/:projectId/preview', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  const project = await findLiveProject(db, projectId);
  if (!project) return error.notFound(c, 'Project', projectId);
  if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
  const body = await parseBody(c, scheduleMoveSchema);
  if (!body.ok) return body.response;

  try {
    const data = await loadScheduleData(db, project);
    const input = buildScheduleInput(data);
    const preview = previewMove(input, body.data);
    if (!preview.ok) return moveRefusal(c, body.data.taskId, preview);
    return success(c, presentMoveImpact(data, computeSchedule(input), preview));
  } catch (err) {
    console.error('[flow-api/project-schedule] preview failed:', err);
    return error.internal(c, 'Failed to preview the move');
  }
});

// ── Apply ───────────────────────────────────────────────────────────────────

app.post('/:projectId/apply', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  const project = await findLiveProject(db, projectId);
  if (!project) return error.notFound(c, 'Project', projectId);
  if (!(await canWriteProject(c, projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, scheduleMoveSchema);
  if (!body.ok) return body.response;

  try {
    const data = await loadScheduleData(db, project);
    // Off: the move is an ordinary edit of the task, which shows its conflicts; nothing else moves.
    if (!data.settings.autoSchedule) return error.conflict(c, AUTO_SCHEDULE_OFF);
    const input = buildScheduleInput(data);
    const preview = previewMove(input, body.data);
    if (!preview.ok) return moveRefusal(c, body.data.taskId, preview);

    const rows = new Map(data.tasks.map((task) => [task.id, task]));
    const now = new Date();
    const writes = preview.moved.map((moved, index) => {
      const row = rows.get(moved.taskId);
      const itself = index === 0;
      const startDate = itself || row?.startDate ? withTimeOfDay(moved.toStart, row?.startDate) : null;
      const dueDate = itself || row?.dueDate ? withTimeOfDay(moved.toFinish, row?.dueDate) : null;
      return { moved, row, itself, startDate, dueDate };
    });
    await atomically(db, (handle) =>
      writes.map(({ moved, startDate, dueDate }) =>
        handle
          .update(tasks)
          .set({
            ...(startDate && { startDate }),
            ...(dueDate && { dueDate }),
            updatedAt: now,
          })
          .where(eq(tasks.id, moved.taskId)),
      ),
    );

    for (const { moved, row, itself, startDate, dueDate } of writes) {
      const newDue = dueDate ?? row?.dueDate ?? null;
      // The standard task payload, plus what moved.
      const rescheduled: Record<string, unknown> = {
        startDate: (startDate ?? row?.startDate ?? null)?.toISOString() ?? null,
        dueDate: newDue ? newDue.toISOString() : null,
        previousStartDate: row?.startDate ? row.startDate.toISOString() : null,
        previousDueDate: row?.dueDate ? row.dueDate.toISOString() : null,
        shiftDays: moved.shiftDays,
        cause: itself ? 'moved' : 'dependency',
      };
      publishEntityEvent({
        c,
        entityType: 'project_task',
        entityId: moved.taskId,
        action: 'rescheduled',
        data: {
          ...taskAnalyticsPayload({ ...row, id: moved.taskId, projectId, dueDate: newDue }),
          ...rescheduled,
        },
      });
    }
    return success(c, { ...presentMoveImpact(data, computeSchedule(input), preview), applied: true });
  } catch (err) {
    console.error('[flow-api/project-schedule] apply failed:', err);
    return error.internal(c, 'Failed to apply the move');
  }
});

export const projectScheduleRoutes = app;
