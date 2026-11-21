/**
 * Alerts: the tenant rows, their DTOs, and the check the cron runs.
 *
 * An alert watches one series of a trends query (a saved trends report, or a
 * spec of its own) and judges the last complete interval in the spec's
 * timezone: the last full hour, yesterday, or last week (Monday to Sunday).
 * See `panelAlertConditionSchema` for the three conditions; the anomaly band is
 * ./anomaly.
 *
 * State: `pending` until the first check, then `ok` or `firing`, or `error`
 * when the check could not run. `fired` is recorded (an alert event, a
 * `panel_alert` entity event, a message on every channel) once, on the move
 * into `firing`; `resolved` once, on the move out of it. A snoozed alert is
 * still checked and its history still written; only the messages wait.
 *
 * Ownership: every member with `panel_reports:read` sees a project's alerts;
 * changing one is for its owner, or `panel_projects:manage`.
 */

import { and, desc, eq, inArray, isNull, lt, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelAlert, PanelAlertEvent } from '@weldsuite/db/schema';
import {
  panelAlertConditionSchema,
  type PanelAlertCondition,
  type PanelAlertDto,
  type PanelAlertEventDto,
  type PanelCheckInterval,
  type PanelDeliveryResult,
  type ParsedCreatePanelAlert,
  type ParsedUpdatePanelAlert,
} from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import {
  trendsSpecSchema,
  type PanelQueryResult,
  type ParsedPanelQuerySpec,
  type ParsedTrendsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { anomalyBand, outsideBand } from './anomaly';
import { deliveryError, type DeliveryTarget, type PanelMessage, type StoredChannels } from './delivery';
import { addDays, formatLocalDate, localParts, nextAlertCheck, weekdayOf, type LocalDate } from './schedule';

const { panelAlertEvents, panelAlerts, panelProjects, panelReports } = schema;

// ---------------------------------------------------------------------------
// Rows and DTOs
// ---------------------------------------------------------------------------

export function storedChannelsOf(alert: Pick<PanelAlert, 'channels' | 'slackWebhookCiphertext'>): StoredChannels {
  return { channels: alert.channels, slackWebhookCiphertext: alert.slackWebhookCiphertext };
}

export function deliveryTargetOf(alert: PanelAlert): DeliveryTarget {
  return { channels: alert.channels, slackWebhookCiphertext: alert.slackWebhookCiphertext, ownerUserId: alert.ownerUserId };
}

export function toAlertDto(a: PanelAlert, nextCheckAt: Date | null): PanelAlertDto {
  const condition = panelAlertConditionSchema.safeParse(a.condition);
  return {
    id: a.id,
    projectId: a.projectId,
    name: a.name,
    reportId: a.reportId,
    spec: a.spec ?? null,
    seriesIndex: a.seriesIndex,
    condition: condition.success ? condition.data : { type: 'threshold', operator: 'above', value: 0 },
    checkInterval: a.checkInterval,
    channels: {
      emailUserIds: [...a.channels.emailUserIds],
      inApp: a.channels.inApp,
      slack: a.slackWebhookCiphertext !== null,
      weldchatChannelId: a.channels.weldchatChannelId ?? null,
    },
    enabled: a.enabled,
    state: a.state,
    lastValue: a.lastValue,
    lastCheckedAt: a.lastCheckedAt?.toISOString() ?? null,
    lastFiredAt: a.lastFiredAt?.toISOString() ?? null,
    lastError: a.lastError,
    snoozedUntil: a.snoozedUntil?.toISOString() ?? null,
    nextCheckAt: a.enabled ? (nextCheckAt?.toISOString() ?? null) : null,
    ownerUserId: a.ownerUserId,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export function toAlertEventDto(e: PanelAlertEvent): PanelAlertEventDto {
  return { id: e.id, alertId: e.alertId, kind: e.kind, value: e.value, bound: e.bound, message: e.message, createdAt: e.createdAt.toISOString() };
}

/** The entity-event payload: id, project, name, state and value; never the channels or the spec. */
export function alertEventData(a: PanelAlert) {
  return { id: a.id, projectId: a.projectId, name: a.name, state: a.state, value: a.lastValue, enabled: a.enabled };
}

/** Where a member opens an alert. */
export function alertPath(id: string): string {
  return `/weldpanel/alerts?alert=${encodeURIComponent(id)}`;
}

export async function listAlerts(db: Database, params: { projectId?: string; ownerUserId?: string }): Promise<PanelAlert[]> {
  const conds: SQL[] = [isNull(panelAlerts.deletedAt)];
  if (params.projectId) conds.push(eq(panelAlerts.projectId, params.projectId));
  if (params.ownerUserId) conds.push(eq(panelAlerts.ownerUserId, params.ownerUserId));
  return db.select().from(panelAlerts).where(and(...conds)).orderBy(desc(panelAlerts.updatedAt)).limit(500);
}

export async function getAlert(db: Database, id: string): Promise<PanelAlert | null> {
  const [row] = await db.select().from(panelAlerts).where(and(eq(panelAlerts.id, id), isNull(panelAlerts.deletedAt))).limit(1);
  return row ?? null;
}

export async function createAlert(db: Database, input: ParsedCreatePanelAlert, stored: StoredChannels, userId: string): Promise<PanelAlert> {
  const [row] = await db
    .insert(panelAlerts)
    .values({
      id: generateId('pnal'),
      projectId: input.projectId,
      name: input.name,
      reportId: input.reportId ?? null,
      spec: input.spec ? (input.spec as unknown as Record<string, unknown>) : null,
      seriesIndex: input.seriesIndex,
      condition: input.condition as unknown as Record<string, unknown>,
      checkInterval: input.checkInterval,
      channels: stored.channels,
      slackWebhookCiphertext: stored.slackWebhookCiphertext,
      enabled: input.enabled,
      ownerUserId: userId,
    })
    .returning();
  return row as PanelAlert;
}

/**
 * Applies an update. A new condition, series, interval or target starts the
 * alert over (`pending`): what it said before no longer describes it.
 */
export async function updateAlert(db: Database, id: string, input: ParsedUpdatePanelAlert, stored: StoredChannels | null): Promise<PanelAlert | null> {
  const retarget = input.reportId !== undefined || input.spec !== undefined;
  const restart = retarget || input.condition !== undefined || input.seriesIndex !== undefined || input.checkInterval !== undefined;
  const [row] = await db
    .update(panelAlerts)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(retarget && {
        reportId: input.reportId ?? null,
        spec: input.spec ? (input.spec as unknown as Record<string, unknown>) : null,
      }),
      ...(input.seriesIndex !== undefined && { seriesIndex: input.seriesIndex }),
      ...(input.condition !== undefined && { condition: input.condition as unknown as Record<string, unknown> }),
      ...(input.checkInterval !== undefined && { checkInterval: input.checkInterval }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(stored && { channels: stored.channels, slackWebhookCiphertext: stored.slackWebhookCiphertext }),
      ...(restart && { state: 'pending' as const, lastValue: null, lastError: null }),
      updatedAt: new Date(),
    })
    .where(and(eq(panelAlerts.id, id), isNull(panelAlerts.deletedAt)))
    .returning();
  return row ?? null;
}

export async function deleteAlert(db: Database, id: string): Promise<PanelAlert | null> {
  const [row] = await db
    .update(panelAlerts)
    .set({ deletedAt: new Date(), updatedAt: new Date(), enabled: false })
    .where(and(eq(panelAlerts.id, id), isNull(panelAlerts.deletedAt)))
    .returning();
  return row ?? null;
}

export async function snoozeAlert(db: Database, id: string, until: Date | null): Promise<PanelAlert | null> {
  const [row] = await db
    .update(panelAlerts)
    .set({ snoozedUntil: until, updatedAt: new Date() })
    .where(and(eq(panelAlerts.id, id), isNull(panelAlerts.deletedAt)))
    .returning();
  return row ?? null;
}

/** An alert's history, newest first; the cursor is the last event's `createdAt` (ISO). */
export async function listAlertEvents(db: Database, alertId: string, cursor: Date | null, limit: number): Promise<PanelAlertEvent[]> {
  const conds: SQL[] = [eq(panelAlertEvents.alertId, alertId)];
  if (cursor) conds.push(lt(panelAlertEvents.createdAt, cursor));
  return db.select().from(panelAlertEvents).where(and(...conds)).orderBy(desc(panelAlertEvents.createdAt)).limit(limit);
}

export async function projectName(db: Database, projectId: string): Promise<string> {
  const [row] = await db.select({ name: panelProjects.name }).from(panelProjects).where(eq(panelProjects.id, projectId)).limit(1);
  return row?.name ?? '';
}

// ---------------------------------------------------------------------------
// The spec an alert runs
// ---------------------------------------------------------------------------

export type AlertSpecResult = { ok: true; spec: ParsedTrendsSpec } | { ok: false; reason: string };

/** A stored or saved trends spec, parsed; refused when it is not a trends query of the alert's project. */
export function parseTrendsSpec(raw: unknown, projectId: string): AlertSpecResult {
  const parsed = trendsSpecSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'The alert watches a query that is not a valid trends query' };
  if (parsed.data.projectId !== projectId) return { ok: false, reason: 'The query is for a different project' };
  return { ok: true, spec: parsed.data };
}

/** The trends spec an alert watches: its own, or its report's (which must still exist and be a trends report). */
export async function resolveAlertSpec(db: Database, alert: Pick<PanelAlert, 'reportId' | 'spec' | 'projectId'>): Promise<AlertSpecResult> {
  if (!alert.reportId) return parseTrendsSpec(alert.spec, alert.projectId);
  const [report] = await db
    .select({ spec: panelReports.spec, kind: panelReports.kind, projectId: panelReports.projectId })
    .from(panelReports)
    .where(and(eq(panelReports.id, alert.reportId), isNull(panelReports.deletedAt)))
    .limit(1);
  if (!report) return { ok: false, reason: 'The report this alert watches was deleted' };
  if (report.projectId !== alert.projectId) return { ok: false, reason: 'The report is in a different project' };
  return parseTrendsSpec(report.spec, alert.projectId);
}

/** The series' name as its report shows it. */
export function seriesLabel(spec: ParsedTrendsSpec, index: number): string {
  const series = spec.series[index];
  return series?.label?.trim() || series?.event || `#${index + 1}`;
}

/** When the alert is next checked; null when it is off. */
export function nextCheckOf(alert: Pick<PanelAlert, 'enabled' | 'deletedAt' | 'checkInterval'>, timezone: string, now: Date): Date | null {
  if (!alert.enabled || alert.deletedAt) return null;
  return nextAlertCheck(alert.checkInterval, timezone, now);
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface CheckWindow {
  interval: 'hour' | 'day' | 'week';
  /** Bucket label of the period judged (the last complete one). */
  target: string;
  /** Bucket label of the period before it. */
  previous: string;
  /** Bucket labels of the anomaly baseline, newest first. */
  baseline: string[];
  /** The custom days to query (YYYY-MM-DD, inclusive, in the spec's timezone). */
  dateRange: { from: string; to: string };
}

const HOUR_MS = 3_600_000;

/** Labels of an hour on the wall clock (a UTC-represented local time), as the query labels hourly buckets. */
function hourLabel(wallMs: number): string {
  return `${new Date(wallMs).toISOString().slice(0, 13)}:00`;
}

function wallDate(wallMs: number): LocalDate {
  const d = new Date(wallMs);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * The period an alert judges at `now`, and what it compares it with: the
 * previous period (`change`), or the previous 28 periods (`anomaly`; for an
 * hourly alert the same hour on each of the previous 14 days). Only the days
 * the condition needs are queried.
 */
export function checkWindow(interval: PanelCheckInterval, condition: PanelAlertCondition['type'], timezone: string, now: Date): CheckWindow {
  const p = localParts(now, timezone);
  if (interval === 'hourly') return hourlyWindow(condition, p);
  if (interval === 'daily') return dailyWindow(condition, p);
  return weeklyWindow(condition, p);
}

/** How far back each check reads before the judged period: hours for hourly alerts, days otherwise. */
const LOOKBACK: Record<PanelCheckInterval, Record<PanelAlertCondition['type'], number>> = {
  hourly: { threshold: 0, change: 1, anomaly: 14 * 24 },
  daily: { threshold: 0, change: 1, anomaly: 28 },
  weekly: { threshold: 0, change: 7, anomaly: 28 * 7 },
};

function hourlyWindow(condition: PanelAlertCondition['type'], p: LocalDate & { hour: number }): CheckWindow {
  const target = Date.UTC(p.year, p.month - 1, p.day, p.hour) - HOUR_MS;
  const back = LOOKBACK.hourly[condition] * HOUR_MS;
  return {
    interval: 'hour',
    target: hourLabel(target),
    previous: hourLabel(target - HOUR_MS),
    baseline: Array.from({ length: 14 }, (_, i) => hourLabel(target - (i + 1) * 24 * HOUR_MS)),
    dateRange: { from: formatLocalDate(wallDate(target - back)), to: formatLocalDate(wallDate(target)) },
  };
}

function dailyWindow(condition: PanelAlertCondition['type'], today: LocalDate): CheckWindow {
  const target = addDays(today, -1);
  return {
    interval: 'day',
    target: formatLocalDate(target),
    previous: formatLocalDate(addDays(target, -1)),
    baseline: Array.from({ length: 28 }, (_, i) => formatLocalDate(addDays(target, -(i + 1)))),
    dateRange: { from: formatLocalDate(addDays(target, -LOOKBACK.daily[condition])), to: formatLocalDate(target) },
  };
}

function weeklyWindow(condition: PanelAlertCondition['type'], today: LocalDate): CheckWindow {
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
  const target = addDays(monday, -7);
  return {
    interval: 'week',
    target: formatLocalDate(target),
    previous: formatLocalDate(addDays(target, -7)),
    baseline: Array.from({ length: 28 }, (_, i) => formatLocalDate(addDays(target, -7 * (i + 1)))),
    dateRange: { from: formatLocalDate(addDays(target, -LOOKBACK.weekly[condition])), to: formatLocalDate(addDays(target, 6)) },
  };
}

/** The alert's spec turned into the check's query: one series, no breakdown or formulas, the window's days and interval. */
export function checkSpec(spec: ParsedTrendsSpec, window: CheckWindow): ParsedTrendsSpec {
  const raw: Record<string, unknown> = { ...spec, dateRange: window.dateRange, interval: window.interval, compare: false };
  delete raw.breakdown;
  delete raw.breakdowns;
  delete raw.formulas;
  delete raw.formulaOnly;
  return trendsSpecSchema.parse(raw);
}

export type Evaluation =
  | { status: 'firing' | 'ok'; value: number; bound: number | null }
  | { status: 'skipped'; value: number | null; bound: null; reason: string };

type ChangeCondition = Extract<PanelAlertCondition, { type: 'change' }>;

/** Percent change from `previous` to `value`; from zero, any move is infinite. */
function percentChange(value: number, previous: number): number {
  if (previous !== 0) return ((value - previous) / Math.abs(previous)) * 100;
  if (value === 0) return 0;
  return Math.sign(value) * Number.POSITIVE_INFINITY;
}

function evaluateChange(condition: ChangeCondition, value: number, previous: number): Evaluation {
  const change = percentChange(value, previous);
  const up = previous + Math.abs(previous) * (condition.percent / 100);
  const down = previous - Math.abs(previous) * (condition.percent / 100);
  if (condition.direction === 'increase') return { status: change >= condition.percent ? 'firing' : 'ok', value, bound: up };
  if (condition.direction === 'decrease') return { status: change <= -condition.percent ? 'firing' : 'ok', value, bound: down };
  return { status: Math.abs(change) >= condition.percent ? 'firing' : 'ok', value, bound: value >= previous ? up : down };
}

/** Judges the target period's value. Pure. */
export function evaluateCondition(condition: PanelAlertCondition, points: ReadonlyMap<string, number>, window: CheckWindow): Evaluation {
  const value = points.get(window.target);
  if (value === undefined) return { status: 'skipped', value: null, bound: null, reason: 'No data for the period (outside the plan’s retention?)' };

  if (condition.type === 'threshold') {
    const firing = condition.operator === 'above' ? value > condition.value : value < condition.value;
    return { status: firing ? 'firing' : 'ok', value, bound: condition.value };
  }

  if (condition.type === 'change') {
    const previous = points.get(window.previous);
    if (previous === undefined) return { status: 'skipped', value, bound: null, reason: 'No data for the period before' };
    return evaluateChange(condition, value, previous);
  }

  const baseline = window.baseline.map((label) => points.get(label)).filter((v): v is number => v !== undefined);
  const band = anomalyBand(baseline, condition.sensitivity);
  if (!band) return { status: 'skipped', value, bound: null, reason: 'Not enough history for an anomaly band yet (7 periods)' };
  const { outside, bound } = outsideBand(value, band);
  return { status: outside ? 'firing' : 'ok', value, bound };
}

/** The series' points from a trends result, by bucket label; null when the result has no such series. */
export function seriesPoints(result: PanelQueryResult, seriesIndex: number): Map<string, number> | null {
  if (result.kind !== 'trends') return null;
  const lines = result.result.series.filter((s) => s.seriesIndex === seriesIndex);
  const line = lines.find((s) => s.breakdownValue === null) ?? lines[0];
  if (!line) return null;
  return new Map(line.points.map((point) => [point.bucket, point.value]));
}

export interface AlertCheckDeps {
  db: Database;
  now: Date;
  /** Runs a spec (through `runCachedQuery` in the worker). */
  run: (spec: ParsedPanelQuerySpec) => Promise<PanelQueryResult>;
  deliver: (target: DeliveryTarget, message: PanelMessage) => Promise<PanelDeliveryResult[]>;
  /** Publishes `panel_alert` `fired` / `resolved`. */
  publish: (alert: PanelAlert, action: 'fired' | 'resolved') => Promise<void>;
}

export type CheckOutcome = 'fired' | 'resolved' | 'firing' | 'ok' | 'skipped' | 'error';

export interface AlertCheckResult {
  alert: PanelAlert;
  outcome: CheckOutcome;
  delivered: PanelDeliveryResult[];
  /** The spec's timezone, for the next check. */
  timezone: string;
}

/** Whether the alert counts as firing: in `firing`, or in `error` after a `fired` that was never resolved. */
async function wasFiring(db: Database, alert: PanelAlert): Promise<boolean> {
  if (alert.state === 'firing') return true;
  if (alert.state !== 'error' || !alert.lastFiredAt) return false;
  const [last] = await db
    .select({ kind: panelAlertEvents.kind })
    .from(panelAlertEvents)
    .where(and(eq(panelAlertEvents.alertId, alert.id), inArray(panelAlertEvents.kind, ['fired', 'resolved'])))
    .orderBy(desc(panelAlertEvents.createdAt))
    .limit(1);
  return last?.kind === 'fired';
}

async function recordEvent(db: Database, alert: PanelAlert, kind: 'fired' | 'resolved' | 'error', value: number | null, bound: number | null, message: string | null): Promise<void> {
  await db.insert(panelAlertEvents).values({ id: generateId('pnae'), alertId: alert.id, projectId: alert.projectId, kind, value, bound, message });
}

function snoozed(alert: PanelAlert, now: Date): boolean {
  return alert.snoozedUntil !== null && alert.snoozedUntil.getTime() > now.getTime();
}

/** The message an alert sends on a state change (or a test). */
export function alertMessage(alert: PanelAlert, input: { event: 'fired' | 'resolved' | 'test'; metric: string; value: number | null; bound: number | null; interval: PanelCheckInterval; period: string | null; projectName: string }): PanelMessage {
  const condition = panelAlertConditionSchema.parse(alert.condition);
  return {
    kind: 'alert',
    entityId: alert.id,
    path: alertPath(alert.id),
    alert: {
      alertName: alert.name,
      projectName: input.projectName,
      event: input.event,
      metric: input.metric,
      value: input.value,
      bound: input.bound,
      condition,
      interval: input.interval,
      period: input.period,
    },
  };
}

async function save(db: Database, id: string, set: Partial<typeof panelAlerts.$inferInsert>): Promise<PanelAlert | null> {
  const [row] = await db
    .update(panelAlerts)
    .set(set)
    .where(and(eq(panelAlerts.id, id), isNull(panelAlerts.deletedAt)))
    .returning();
  return row ?? null;
}

/**
 * Checks one alert: runs its query for the window, judges it, moves its state,
 * writes its history and sends its messages. Never throws for a failed query:
 * the alert goes to `error` with the reason.
 */
export async function runAlertCheck(deps: AlertCheckDeps, alert: PanelAlert): Promise<AlertCheckResult> {
  const { db, now } = deps;
  const measured = await measure(deps, alert);

  if (!measured.ok) {
    const reason = measured.reason.slice(0, 1000);
    if (alert.state !== 'error') await recordEvent(db, alert, 'error', null, null, reason);
    const row = await save(db, alert.id, { state: 'error', lastError: reason, lastCheckedAt: now, updatedAt: now });
    return { alert: row ?? alert, outcome: 'error', delivered: [], timezone: measured.timezone };
  }

  const timezone = measured.spec.timezone;
  const { evaluation } = measured;
  const firingBefore = await wasFiring(db, alert);

  if (evaluation.status === 'skipped') {
    let state = alert.state;
    if (state === 'error') state = firingBefore ? 'firing' : 'pending';
    const row = await save(db, alert.id, { state, lastValue: evaluation.value, lastError: null, lastCheckedAt: now, updatedAt: now });
    return { alert: row ?? alert, outcome: 'skipped', delivered: [], timezone };
  }

  const firing = evaluation.status === 'firing';
  const steady: 'firing' | 'ok' = firing ? 'firing' : 'ok';
  const change = transitionOf(firing, firingBefore);
  const row = await save(db, alert.id, {
    state: steady,
    lastValue: evaluation.value,
    lastError: null,
    lastCheckedAt: now,
    ...(change === 'fired' && { lastFiredAt: now }),
    updatedAt: now,
  });
  if (!row || !change) return { alert: row ?? alert, outcome: steady, delivered: [], timezone };

  await recordEvent(db, row, change, evaluation.value, evaluation.bound, null);
  await deps.publish(row, change);
  const announced = await announce(deps, row, change, { spec: measured.spec, window: measured.window, value: evaluation.value, bound: evaluation.bound });
  return { alert: announced.row, outcome: change, delivered: announced.delivered, timezone };
}

type Measured =
  | { ok: true; spec: ParsedTrendsSpec; window: CheckWindow; evaluation: Evaluation }
  | { ok: false; reason: string; timezone: string };

/** Resolves the alert's query, runs it for the window and judges the value. */
async function measure(deps: AlertCheckDeps, alert: PanelAlert): Promise<Measured> {
  const resolved = await resolveAlertSpec(deps.db, alert);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, timezone: 'UTC' };
  const timezone = resolved.spec.timezone;
  const condition = panelAlertConditionSchema.safeParse(alert.condition);
  if (!condition.success) return { ok: false, reason: 'The alert’s condition is not valid', timezone };

  const window = checkWindow(alert.checkInterval, condition.data.type, timezone, deps.now);
  let points: Map<string, number> | null;
  try {
    points = seriesPoints(await deps.run(checkSpec(resolved.spec, window)), alert.seriesIndex);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'The query failed', timezone };
  }
  if (!points) return { ok: false, reason: 'The query has no such series', timezone };
  return { ok: true, spec: resolved.spec, window, evaluation: evaluateCondition(condition.data, points, window) };
}

/** The state change a judged value makes: `fired` into firing, `resolved` out of it, else none. */
function transitionOf(firing: boolean, firingBefore: boolean): 'fired' | 'resolved' | null {
  if (firing && !firingBefore) return 'fired';
  if (!firing && firingBefore) return 'resolved';
  return null;
}

interface Judged {
  spec: ParsedTrendsSpec;
  window: CheckWindow;
  value: number;
  bound: number | null;
}

/** Messages the channels about a state change (unless snoozed) and records a delivery failure on the alert. */
async function announce(deps: AlertCheckDeps, row: PanelAlert, change: 'fired' | 'resolved', judged: Judged): Promise<{ row: PanelAlert; delivered: PanelDeliveryResult[] }> {
  if (snoozed(row, deps.now)) return { row, delivered: [] };
  const message = alertMessage(row, {
    event: change,
    metric: seriesLabel(judged.spec, row.seriesIndex),
    value: judged.value,
    bound: judged.bound,
    interval: row.checkInterval,
    period: judged.window.target,
    projectName: await projectName(deps.db, row.projectId),
  });
  const delivered = await deps.deliver(deliveryTargetOf(row), message);
  const failure = deliveryError(delivered);
  if (!failure) return { row, delivered };
  return { row: (await save(deps.db, row.id, { lastError: failure, updatedAt: deps.now })) ?? row, delivered };
}
