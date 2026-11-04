/**
 * Status report sweep — Cloudflare cron handler (ADR FLOW-018).
 *
 * A project that has a `statusReport` schedule in `projects.settings` gets a
 * draft on its cadence's slot day: the sweep creates the draft for the period
 * the latest slot reports on (computed from the project's data, like
 * `POST /api/project-status-reports`) and tells the project manager it is
 * ready to review. The project manager writes the summary and publishes.
 *
 * Scheduling follows ADR DATA-008 (nothing opens tenant databases on a
 * timer): saving a schedule marks the workspace due in the schedule-index D1
 * (`workspace_due_index`, kind `status_report_due`), and the daily sweep (the
 * `30 3 * * *` trigger, next to the file purge) reads only that index, opens
 * just the due workspaces and stores when the next slot of any of their
 * projects comes (or drops the row when no project has a schedule left).
 * Nothing existed before this index, so there is nothing to seed.
 *
 * A period that already has a report row (a draft, a published report, or a
 * draft the project manager discarded) is not drafted again.
 */

import { and, isNull, sql } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';
import { runDueIndexSweep, type DueIndexSweepResult } from '@weldsuite/worker-kit/due-index';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { STATUS_REPORT_CADENCES } from '@weldsuite/app-api-client/schemas/project-reporting';
import { lastSlotOnOrBefore, nextSlotAfter, periodForSlot, statusReportEventData } from '@weldsuite/flow-domain/status-report';
import type { Env } from '../types';
import { notifyDraftReady } from '../lib/report-notifications';
import { insertDraft, periodHandled, scheduleOf, type ReportProject } from '../services/status-reports';

/** The cron expression that runs this sweep (the daily one; keep in step with wrangler.toml). */
export const STATUS_REPORT_CRONS = ['30 3 * * *'] as const;

export function isStatusReportCron(cron: string): boolean {
  return (STATUS_REPORT_CRONS as readonly string[]).includes(cron);
}

/** KV flag of the sweep's one-time seed (there is nothing to seed: no schedule existed before the index). */
export const STATUS_REPORT_SEED_KEY = 'flow:status-report-index:seed:v1';

/** A workspace that failed (Neon hiccup, broken tenant) is retried after this. */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/** Project statuses (lower-cased) that no longer get reports. */
const FINISHED_STATUSES = ['closed', 'completed', 'archived', 'cancelled'];

/** The projects of a tenant that have a status report schedule and are still running. */
async function scheduledProjects(db: Database): Promise<ReportProject[]> {
  const p = schema.projects;
  return db
    .select({
      id: p.id,
      name: p.name,
      status: p.status,
      projectManagerId: p.projectManagerId,
      endDate: p.endDate,
      budgetCurrency: p.budgetCurrency,
      settings: p.settings,
    })
    .from(p)
    .where(
      and(
        isNull(p.deletedAt),
        sql`jsonb_typeof(${p.settings} -> 'statusReport') = 'object'`,
        sql`lower(${p.status}) not in (${sql.join(FINISHED_STATUSES.map((status) => sql`${status}`), sql`, `)})`,
      ),
    );
}

/**
 * Draft what is due in one workspace and answer when the next slot of any of
 * its scheduled projects comes (null: none has a schedule). Throws after the
 * loop when some project failed, so the index retries the workspace; a
 * project drafted meanwhile is not drafted twice.
 */
export async function sweepStatusReports(env: Env, db: Database, orgId: string, now: Date): Promise<Date | null> {
  let next: Date | null = null;
  let failed: unknown = null;
  for (const project of await scheduledProjects(db)) {
    const schedule = scheduleOf(project);
    if (!schedule || !(STATUS_REPORT_CADENCES as readonly string[]).includes(schedule.cadence) || schedule.weekday < 1 || schedule.weekday > 7) continue;
    try {
      const period = periodForSlot(schedule.cadence, lastSlotOnOrBefore(schedule, now));
      if (!(await periodHandled(db, project.id, period))) {
        const report = await insertDraft(db, project, { period, now, createdBy: 'system', supersedes: null });
        if (report) {
          await publishEntityEventRaw({
            env,
            workspaceId: orgId,
            userId: 'system',
            entityType: 'project_status_report',
            action: 'created',
            entityId: report.id,
            data: statusReportEventData(report),
          });
          // The workspace's `workspaces.id` is not known here and not needed: only the in-app notification goes out.
          await notifyDraftReady({ env, db, workspaceId: orgId, clerkOrgId: orgId, actorId: null }, { report, project });
        }
      }
      const slot = nextSlotAfter(schedule, now);
      if (!next || slot < next) next = slot;
    } catch (err) {
      failed = err;
      console.error(`[StatusReports] project ${project.id} failed:`, err);
    }
  }
  if (failed) throw failed instanceof Error ? failed : new Error('status report sweep failed');
  return next;
}

/**
 * Daily tick: opens only the workspaces the `status_report_due` due index
 * lists as due, never a tenant that is not listed.
 */
export async function runStatusReportSweep(env: Env, now: Date = new Date()): Promise<DueIndexSweepResult> {
  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'status_report_due',
    label: '[StatusReports]',
    seed: { key: STATUS_REPORT_SEED_KEY, listWorkspaces: async () => [] },
    retryAfterMs: RETRY_AFTER_MS,
    now: now.getTime(),
    process: async (orgId) => {
      const db = (await getTenantDbForWorkspace(env, orgId)) as unknown as Database;
      return sweepStatusReports(env, db, orgId, now);
    },
  });
  if (result.due > 0 || result.failed > 0) {
    console.log(`[StatusReports] due=${result.due} processed=${result.processed} failed=${result.failed}`);
  }
  return result;
}
