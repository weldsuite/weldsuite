/**
 * Scheduled report emails: /api/helpdesk-analytics/schedules (TASK-1228).
 *
 * A schedule sends the overview (`reportId` null) or a saved report by email
 * every day, week or month, optionally with the numbers as a CSV. The sweep
 * (cron/report-schedule-sweep.ts) sends them; this file is the CRUD and the
 * "send now" button.
 *
 * Permissions: settings:read (list) | settings:create | settings:update (also
 * send now) | settings:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createHelpdeskReportScheduleSchema,
  updateHelpdeskReportScheduleSchema,
  type HelpdeskReportScheduleDto,
} from '@weldsuite/core-api-client/schemas/helpdesk-analytics';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { markDeskReportDue } from '../../lib/report-due';
import {
  nextReportRun,
  reportTitles,
  scheduleDto,
  sendScheduledReport,
  timingOf,
  type ReportScheduleRow,
  type ReportSendResult,
  type ReportTiming,
} from '../../services/desk-report-schedules';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const { helpdeskReportSchedules: schedules, helpdeskAnalyticsReports: reports } = schema;

const REPORT_GONE_NOW = 'The saved report no longer exists.';

/** A schedule only keeps the day field its frequency uses. */
function normalizeTiming(timing: ReportTiming): ReportTiming {
  return {
    ...timing,
    dayOfWeek: timing.frequency === 'weekly' ? timing.dayOfWeek : null,
    dayOfMonth: timing.frequency === 'monthly' ? timing.dayOfMonth : null,
  };
}

/** The timing a PATCH leaves: the stored fields, replaced by those in the body. */
function mergedTiming(existing: ReportScheduleRow, patch: Partial<ReportTiming>): ReportTiming {
  return normalizeTiming({
    frequency: patch.frequency ?? existing.frequency,
    dayOfWeek: patch.dayOfWeek !== undefined ? patch.dayOfWeek : existing.dayOfWeek,
    dayOfMonth: patch.dayOfMonth !== undefined ? patch.dayOfMonth : existing.dayOfMonth,
    hour: patch.hour ?? existing.hour,
    timezone: patch.timezone ?? existing.timezone,
  });
}

function sameTiming(a: ReportTiming, b: ReportTiming): boolean {
  return (
    a.frequency === b.frequency &&
    a.dayOfWeek === b.dayOfWeek &&
    a.dayOfMonth === b.dayOfMonth &&
    a.hour === b.hour &&
    a.timezone === b.timezone
  );
}

/** What a timing lacks for its frequency, as the 400 message; null when it is complete. */
function timingProblem(timing: ReportTiming): string | null {
  if (timing.frequency === 'weekly' && timing.dayOfWeek === null) return 'dayOfWeek is required for a weekly schedule';
  if (timing.frequency === 'monthly' && timing.dayOfMonth === null) return 'dayOfMonth is required for a monthly schedule';
  return null;
}

/** The next run a PATCH leaves: it moves only when the timing changed or the schedule is switched on again. */
function nextRunAfterPatch(existing: ReportScheduleRow, timing: ReportTiming, enabled: boolean, now: Date): Date | null {
  if (!enabled) return null;
  const retime = !sameTiming(timing, timingOf(existing)) || !existing.enabled || !existing.nextRunAt;
  return retime ? nextReportRun(timing, now) : existing.nextRunAt;
}

/** The columns a PATCH writes from its body: a field the body leaves out keeps its stored value. */
function patchedColumns(data: z.output<typeof updateHelpdeskReportScheduleSchema>, timing: ReportTiming) {
  return {
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.reportId !== undefined ? { reportId: data.reportId } : {}),
    ...(data.range !== undefined ? { range: data.range } : {}),
    ...timing,
    ...(data.recipients !== undefined ? { recipients: data.recipients } : {}),
    ...(data.attachCsv !== undefined ? { attachCsv: data.attachCsv } : {}),
    ...(data.locale !== undefined ? { locale: data.locale } : {}),
  };
}

/** What "send now" answers: a saved report that is gone counts as a failed send. */
function sendNowResult(outcome: ReportSendResult): { status: 'failed'; error: string } | { status: 'sent' } {
  if (outcome.status === 'gone') return { status: 'failed', error: REPORT_GONE_NOW };
  if (outcome.status === 'failed') return { status: 'failed', error: outcome.error };
  return { status: 'sent' };
}

/** Whether a live (not deleted) saved report has this id. */
async function reportExists(db: Database, reportId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: reports.id })
    .from(reports)
    .where(and(eq(reports.id, reportId), isNull(reports.deletedAt)))
    .limit(1);
  return !!row;
}

async function dtoOf(db: Database, row: ReportScheduleRow): Promise<HelpdeskReportScheduleDto> {
  const titles = await reportTitles(db, [row.reportId]);
  return scheduleDto(row, row.reportId ? (titles.get(row.reportId) ?? null) : null);
}

async function findSchedule(db: Database, id: string): Promise<ReportScheduleRow | undefined> {
  const [row] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
  return row;
}

// Newest first. The list is small (a team has a handful of schedules), so it is not paginated.
app.get('/', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const rows = await db.select().from(schedules).orderBy(desc(schedules.createdAt), desc(schedules.id));
    const titles = await reportTitles(db, rows.map((row) => row.reportId));
    return success(
      c,
      rows.map((row) => scheduleDto(row, row.reportId ? (titles.get(row.reportId) ?? null) : null)),
    );
  } catch (err) {
    console.error('[desk-api/helpdesk-analytics] list report schedules failed:', err);
    return error.internal(c, 'Failed to fetch report schedules');
  }
});

app.post('/', requirePermission('settings:create'), zValidator('json', createHelpdeskReportScheduleSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    if (data.reportId && !(await reportExists(db, data.reportId))) {
      return error.badRequest(c, 'The saved report does not exist');
    }
    const now = new Date();
    const timing = normalizeTiming({
      frequency: data.frequency,
      dayOfWeek: data.dayOfWeek ?? null,
      dayOfMonth: data.dayOfMonth ?? null,
      hour: data.hour,
      timezone: data.timezone,
    });
    const enabled = data.enabled ?? true;
    const nextRunAt = enabled ? nextReportRun(timing, now) : null;
    const [created] = await db
      .insert(schedules)
      .values({
        id: generateId('rsch'),
        createdAt: now,
        updatedAt: now,
        name: data.name,
        reportId: data.reportId ?? null,
        range: data.range ?? 'last_7_days',
        ...timing,
        recipients: data.recipients,
        attachCsv: data.attachCsv ?? true,
        locale: data.locale ?? 'en',
        enabled,
        createdById: c.get('userId'),
        nextRunAt,
      })
      .returning();
    if (!created) return error.internal(c, 'Failed to create report schedule');
    const dto = await dtoOf(db, created);
    markDeskReportDue(c, nextRunAt);
    publishEntityEvent({
      c,
      entityType: 'helpdesk_report_schedule',
      entityId: created.id,
      action: 'created',
      data: dto as unknown as Record<string, unknown>,
    });
    return success(c, dto, 201);
  } catch (err) {
    console.error('[desk-api/helpdesk-analytics] create report schedule failed:', err);
    return error.internal(c, 'Failed to create report schedule');
  }
});

app.patch('/:id', requirePermission('settings:update'), zValidator('json', updateHelpdeskReportScheduleSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const existing = await findSchedule(db, id);
    if (!existing) return error.notFound(c, 'Report schedule', id);

    const timing = mergedTiming(existing, data);
    const problem = timingProblem(timing);
    if (problem) return error.badRequest(c, problem);
    if (data.reportId && !(await reportExists(db, data.reportId))) {
      return error.badRequest(c, 'The saved report does not exist');
    }

    const now = new Date();
    const enabled = data.enabled ?? existing.enabled;
    const nextRunAt = nextRunAfterPatch(existing, timing, enabled, now);

    const [updated] = await db
      .update(schedules)
      .set({
        updatedAt: now,
        ...patchedColumns(data, timing),
        enabled,
        nextRunAt,
      })
      .where(eq(schedules.id, id))
      .returning();
    if (!updated) return error.notFound(c, 'Report schedule', id);
    const dto = await dtoOf(db, updated);
    markDeskReportDue(c, nextRunAt);
    publishEntityEvent({
      c,
      entityType: 'helpdesk_report_schedule',
      entityId: id,
      action: 'updated',
      data: dto as unknown as Record<string, unknown>,
    });
    return success(c, dto);
  } catch (err) {
    console.error('[desk-api/helpdesk-analytics] update report schedule failed:', err);
    return error.internal(c, 'Failed to update report schedule');
  }
});

app.delete('/:id', requirePermission('settings:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const deleted = await db.delete(schedules).where(eq(schedules.id, id)).returning({ id: schedules.id });
    if (deleted.length === 0) return error.notFound(c, 'Report schedule', id);
    publishEntityEvent({
      c,
      entityType: 'helpdesk_report_schedule',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[desk-api/helpdesk-analytics] delete report schedule failed:', err);
    return error.internal(c, 'Failed to delete report schedule');
  }
});

// Send now: to the schedule's recipients, whatever its timing. Records how it went
// (lastRunAt, lastStatus, lastError) and leaves nextRunAt alone.
app.post('/:id/send', requirePermission('settings:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await findSchedule(db, id);
    if (!existing) return error.notFound(c, 'Report schedule', id);

    const now = new Date();
    const outcome = await sendScheduledReport({ env: c.env, db, clerkOrgId: c.get('clerkOrgId'), schedule: existing, now });
    const result = sendNowResult(outcome);

    const [updated] = await db
      .update(schedules)
      .set({
        lastRunAt: now,
        lastStatus: result.status,
        lastError: result.status === 'failed' ? result.error : null,
      })
      .where(eq(schedules.id, id))
      .returning();
    if (updated) {
      publishEntityEvent({
        c,
        entityType: 'helpdesk_report_schedule',
        entityId: id,
        action: 'updated',
        data: (await dtoOf(db, updated)) as unknown as Record<string, unknown>,
      });
    }
    return success(c, result);
  } catch (err) {
    console.error('[desk-api/helpdesk-analytics] send report schedule failed:', err);
    return error.internal(c, 'Failed to send the report');
  }
});

export const reportSchedulesRoutes = app;
