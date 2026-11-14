/**
 * Scheduled WeldDesk report emails (TASK-1228): when a schedule runs next, how
 * a row is shown through the API, and building and sending one report email.
 *
 * Plain functions, no Hono context: the routes (send now) and the sweep
 * (cron/report-schedule-sweep.ts) both call them.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  emailStrings,
  fill,
  resolveEmailLocale,
  sendSystemEmail,
  SYSTEM_FROM_ADDRESS,
  workspaceAppUrl,
  type DeskReportEmailProps,
  type EmailLocale,
  type OutgoingAttachment,
} from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import {
  checkOutbound,
  commitOutbound,
  OutboundDeniedError,
  releaseOutbound,
  type OutboundReservation,
} from '@weldsuite/mail-domain/outbound';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { HelpdeskReportScheduleDto } from '@weldsuite/core-api-client/schemas/helpdesk-analytics';
import type { Env } from '../types';
import {
  dateKeyOf,
  loadSavedReport,
  overviewCsv,
  overviewCsvFilename,
  reportCsvFilename,
  savedReportCsv,
  type SavedReportData,
} from './desk-report-export';
import { deskReportRangeOf, deskReportsOverview } from './desk-reports';

export type ReportScheduleRow = typeof schema.helpdeskReportSchedules.$inferSelect;

// ── When a schedule runs ────────────────────────────────────────────────────

/** The fields of a schedule that decide when it runs. */
export interface ReportTiming {
  frequency: 'daily' | 'weekly' | 'monthly';
  /** Weekly: 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number | null;
  /** Monthly: 1 … 28. */
  dayOfMonth: number | null;
  /** 0 … 23, read in `timezone`. */
  hour: number;
  /** IANA zone. */
  timezone: string;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall clock of `instant` in `timeZone`, read back as if it were UTC. */
function wallClockAsUtc(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

/** Milliseconds `timeZone` is ahead of UTC at `instant`. */
function zoneOffset(instant: number, timeZone: string): number {
  // The wall clock is whole seconds, so drop the milliseconds before comparing.
  const whole = Math.floor(instant / 1000) * 1000;
  return wallClockAsUtc(whole, timeZone) - whole;
}

/**
 * The instant at which the wall clock of `timeZone` reads `year-month-day hour:00`.
 * A time that happens twice (the clock goes back) is the first one; a time that
 * is skipped (the clock jumps forward) is the moment the clock jumps, so a
 * 02:30 run on the day the clock goes from 02:00 to 03:00 happens at 03:30.
 */
function zonedInstant(year: number, month: number, day: number, hour: number, timeZone: string): number {
  const wall = Date.UTC(year, month, day, hour, 0, 0);
  const before = zoneOffset(wall - DAY_MS, timeZone);
  const after = zoneOffset(wall + DAY_MS, timeZone);
  const candidates = [wall - before, wall - after].filter((t) => zoneOffset(t, timeZone) === wall - t);
  if (candidates.length > 0) return Math.min(...candidates);
  return wall - before;
}

/**
 * The next moment strictly after `after` that falls on the schedule's day at
 * `hour:00` in its time zone: every day for `daily`, the `dayOfWeek` for
 * `weekly`, the `dayOfMonth` (1 to 28, so every month has it) for `monthly`.
 * Daylight saving time is followed: 08:00 is 08:00 local before and after the
 * change.
 */
export function nextReportRun(timing: ReportTiming, after: Date): Date {
  const local = new Date(wallClockAsUtc(after.getTime(), timing.timezone));
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  // A month has at most 31 days, so a monthly schedule matches within 32 days of any start.
  for (let i = 0; i <= 32; i += 1) {
    const candidate = new Date(Date.UTC(year, month, day + i));
    const matches =
      timing.frequency === 'daily' ||
      (timing.frequency === 'weekly' && candidate.getUTCDay() === timing.dayOfWeek) ||
      (timing.frequency === 'monthly' && candidate.getUTCDate() === timing.dayOfMonth);
    if (!matches) continue;
    const instant = zonedInstant(
      candidate.getUTCFullYear(),
      candidate.getUTCMonth(),
      candidate.getUTCDate(),
      timing.hour,
      timing.timezone,
    );
    if (instant > after.getTime()) return new Date(instant);
  }
  throw new Error(`No next run for the ${timing.frequency} schedule (day ${timing.dayOfWeek ?? timing.dayOfMonth})`);
}

/** The next run of a stored schedule, null while it is disabled. */
export function nextRunOf(row: ReportScheduleRow, after: Date): Date | null {
  return row.enabled ? nextReportRun(timingOf(row), after) : null;
}

export function timingOf(row: ReportScheduleRow): ReportTiming {
  return {
    frequency: row.frequency,
    dayOfWeek: row.dayOfWeek,
    dayOfMonth: row.dayOfMonth,
    hour: row.hour,
    timezone: row.timezone,
  };
}

// ── The API shape ───────────────────────────────────────────────────────────

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** A stored schedule as the API returns it. */
export function scheduleDto(row: ReportScheduleRow, reportTitle: string | null): HelpdeskReportScheduleDto {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    name: row.name,
    reportId: row.reportId,
    reportTitle,
    range: deskReportRangeOf(row.range),
    frequency: row.frequency,
    dayOfWeek: row.dayOfWeek,
    dayOfMonth: row.dayOfMonth,
    hour: row.hour,
    timezone: row.timezone,
    recipients: row.recipients,
    attachCsv: row.attachCsv,
    locale: row.locale === 'nl' ? 'nl' : 'en',
    enabled: row.enabled,
    createdById: row.createdById,
    nextRunAt: iso(row.nextRunAt),
    lastRunAt: iso(row.lastRunAt),
    lastStatus: row.lastStatus,
    lastError: row.lastError,
  };
}

/** The titles of the saved reports the schedules point at (deleted ones are absent). */
export async function reportTitles(db: Database, reportIds: Array<string | null>): Promise<Map<string, string>> {
  const ids = [...new Set(reportIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const { helpdeskAnalyticsReports } = schema;
  const rows = await db
    .select({ id: helpdeskAnalyticsReports.id, title: helpdeskAnalyticsReports.title })
    .from(helpdeskAnalyticsReports)
    .where(and(inArray(helpdeskAnalyticsReports.id, ids), isNull(helpdeskAnalyticsReports.deletedAt)));
  return new Map(rows.map((row) => [row.id, row.title]));
}

// ── Sending ─────────────────────────────────────────────────────────────────

export type ReportSendResult =
  | { status: 'sent' }
  | { status: 'failed'; error: string }
  /** The saved report the schedule sends no longer exists. */
  | { status: 'gone' };

const MAX_ERROR_LENGTH = 500;
const TOP_AGENTS = 5;
const CHART_ROWS = 10;

/** What a schedule's lastError says when the outbound mail guard refused the send. */
export const REPORT_HELD_BACK_MESSAGE =
  'The send was held back by the outbound mail limits. It will be tried again at the next scheduled run.';

export const REPORT_GONE_MESSAGE = 'The saved report was deleted, so this schedule was turned off.';

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text || 'Sending failed').slice(0, MAX_ERROR_LENGTH);
}

/** The platform base URL the report link starts from (`PUBLIC_APP_URL`, else the app of the environment). */
export function appBaseUrl(env: Pick<Env, 'PUBLIC_APP_URL' | 'ENVIRONMENT'>): string {
  const configured = env.PUBLIC_APP_URL?.trim();
  if (configured) return configured;
  if (env.ENVIRONMENT === 'test') return 'https://app-test.weldsuite.org';
  if (env.ENVIRONMENT === 'development') return 'http://localhost:3000';
  return 'https://app.weldsuite.org';
}

/** "Mar 15, 2026" / "15 mrt 2026", of a UTC date key. */
function shortDate(dateKey: string, locale: EmailLocale): string {
  return new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${dateKey}T00:00:00Z`));
}

/** The days an overview covers as the reader sees them: one date, or "start to end" (`end` is exclusive in the overview). */
export function overviewPeriodLabel(range: { start: string; end: string }, locale: EmailLocale): string {
  const last = dateKeyOf(new Date(new Date(`${range.end}T00:00:00Z`).getTime() - DAY_MS));
  if (last <= range.start) return shortDate(range.start, locale);
  return fill(emailStrings(locale).deskReport.periodRange, {
    start: shortDate(range.start, locale),
    end: shortDate(last, locale),
  });
}

interface ReportContent {
  props: Omit<DeskReportEmailProps, 'scheduleName' | 'url' | 'scheduledBy' | 'csvAttached'>;
  csv: { filename: string; content: string };
  /** The in-app path of the report, under the workspace. */
  path: string;
}

async function overviewContent(db: Database, schedule: ReportScheduleRow, locale: EmailLocale, now: Date): Promise<ReportContent> {
  const overview = await deskReportsOverview(db, schedule.range, now);
  const { kpis } = overview;
  return {
    props: {
      reportTitle: null,
      periodLabel: overviewPeriodLabel(overview.range, locale),
      kpis: [
        { key: 'created', ...kpis.created },
        { key: 'resolved', ...kpis.resolved },
        { key: 'firstResponseMedian', ...kpis.firstResponseMedian },
        { key: 'resolutionMedian', ...kpis.resolutionMedian },
        { key: 'slaCompliance', ...kpis.slaCompliance },
        { key: 'csat', ...kpis.csat },
      ],
      backlog: overview.backlog,
      agents: overview.agents
        .filter((agent) => agent.id !== null)
        .slice(0, TOP_AGENTS)
        .map((agent) => ({ name: agent.name, resolved: agent.resolved, csat: agent.csat })),
    },
    csv: { filename: overviewCsvFilename(overview.range.key, now), content: overviewCsv(overview) },
    path: '/welddesk/reports',
  };
}

function savedReportContent(report: SavedReportData, locale: EmailLocale, now: Date): ReportContent {
  return {
    props: {
      reportTitle: report.title,
      periodLabel: shortDate(dateKeyOf(now), locale),
      charts: report.charts.map((chart) => ({
        title: chart.title,
        // A breakdown lists its first rows (the biggest), a time series its latest.
        rows: (chart.breakdown ? chart.points.slice(0, CHART_ROWS) : chart.points.slice(-CHART_ROWS)).map((point) => ({
          label: point.label,
          value: point.value,
        })),
      })),
    },
    csv: { filename: reportCsvFilename(report, now), content: savedReportCsv(report) },
    path: `/welddesk/reports/custom/${encodeURIComponent(report.id)}`,
  };
}

async function memberName(db: Database, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { workspaceMembers } = schema;
  const [member] = await db
    .select({ name: workspaceMembers.name })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);
  return member?.name?.trim() || null;
}

/** Count what went out, or give the reservation back when nothing did. Never throws. */
async function settle(
  env: Env,
  db: Database,
  reservation: OutboundReservation | null,
  sent: string[],
  recipientCount = 0,
): Promise<void> {
  if (!reservation) return;
  try {
    if (sent.length === 0) await releaseOutbound(env, reservation);
    else await commitOutbound(env, db, reservation, sent.length < recipientCount ? { sentRecipients: sent } : {});
  } catch (err) {
    console.error('[DeskReports] settling the outbound reservation failed:', err);
  }
}

export interface SendReportOptions {
  env: Env;
  db: Database;
  /** The workspace's Clerk org id, for the link into the app. */
  clerkOrgId: string;
  schedule: ReportScheduleRow;
  now: Date;
}

/**
 * Build the schedule's report and mail it to its recipients (one message, all
 * of them in To), with the CSV attached when the schedule says so. Never
 * throws: a failure comes back as `failed` with a message to show; a deleted
 * saved report as `gone`.
 */
export async function sendScheduledReport(options: SendReportOptions): Promise<ReportSendResult> {
  const { env, db, clerkOrgId, schedule, now } = options;
  try {
    const transport = workerTransport(env);
    if (!transport) return { status: 'failed', error: 'Email sending is not configured for this workspace.' };

    const locale = resolveEmailLocale(schedule.locale);
    let content: ReportContent;
    if (schedule.reportId) {
      const report = await loadSavedReport(db, schedule.reportId, now);
      if (!report) return { status: 'gone' };
      content = savedReportContent(report, locale, now);
    } else {
      content = await overviewContent(db, schedule, locale, now);
    }

    const attachments: OutgoingAttachment[] = schedule.attachCsv
      ? [{ filename: content.csv.filename, content: content.csv.content, contentType: 'text/csv; charset=utf-8' }]
      : [];
    // The outbound mail guard (weldsuite-documentation/plans/weldmail-outbound-abuse.md): the mail goes out
    // from WeldSuite's address and carries workspace-written names and titles.
    let reservation: OutboundReservation | null = null;
    try {
      reservation = await checkOutbound(env, db, {
        subject: { kind: 'workspace', clerkOrgId },
        source: 'desk_report',
        kind: 'new_thread',
        from: SYSTEM_FROM_ADDRESS,
        systemSender: true,
        to: schedule.recipients,
        subjectLine: content.props.reportTitle?.trim() || schedule.name,
        text: [schedule.name, ...(content.props.charts ?? []).map((chart) => chart.title)].join(' '),
      });
    } catch (err) {
      if (err instanceof OutboundDeniedError) {
        console.warn(`[DeskReports] schedule ${schedule.id} held back by the outbound guard (${err.code})`);
        return { status: 'failed', error: REPORT_HELD_BACK_MESSAGE };
      }
      // Fails open, like the calendar: a report is worth more than a gap in counting.
      console.error('[DeskReports] outbound guard failed, sending anyway:', err);
    }

    let result;
    try {
      result = await sendSystemEmail(transport, {
      template: 'desk.report',
      props: {
        ...content.props,
        scheduleName: schedule.name,
        url: workspaceAppUrl(appBaseUrl(env), clerkOrgId, content.path),
        scheduledBy: await memberName(db, schedule.createdById),
        csvAttached: attachments.length > 0,
      },
      to: schedule.recipients,
      locale,
      attachments,
      });
    } catch (err) {
      await settle(env, db, reservation, []);
      throw err;
    }
    const refused = new Set((result.rejected ?? []).map((r) => r.toLowerCase()));
    const delivered = schedule.recipients.filter((r) => !refused.has(r.toLowerCase()));
    await settle(env, db, reservation, delivered, schedule.recipients.length);
    if (delivered.length === 0) {
      return { status: 'failed', error: 'Every recipient was refused by the mail service.' };
    }
    return { status: 'sent' };
  } catch (err) {
    console.error(`[DeskReports] sending schedule ${schedule.id} failed:`, err);
    return { status: 'failed', error: errorText(err) };
  }
}
