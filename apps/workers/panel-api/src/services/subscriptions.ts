/**
 * Scheduled reports (subscriptions): a saved report or dashboard sent on a
 * schedule by email, in-app, Slack or WeldChat.
 *
 * What goes out: for a report, its headline numbers (with the change against
 * the period before for web and trends reports, which are run with `compare`)
 * and its top rows; for a dashboard, one block per report tile (at most 12,
 * in grid order), with the dashboard's own date range and filters applied.
 * Every report runs through `runCachedQuery` with its own scope; one that
 * fails becomes a "could not be run" block, never a failed send.
 *
 * Ownership like alerts: visible to every member with `panel_reports:read`,
 * changed by the owner or `panel_projects:manage`. The target must be one the
 * owner can see when the subscription is made.
 */

import { and, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { emailStrings, fill, type EmailLocale } from '@weldsuite/emails';
import type { PanelDashboard, PanelReport, PanelSubscription } from '@weldsuite/db/schema';
import {
  panelSubscriptionScheduleSchema,
  type PanelDeliveryResult,
  type PanelSubscriptionDto,
  type ParsedCreatePanelSubscription,
  type ParsedUpdatePanelSubscription,
} from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import {
  panelDateRangeSchema,
  panelFilterSchema,
  panelQuerySpecSchema,
  type PanelQueryResult,
  type ParsedPanelQuerySpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { DeliveryTarget, DigestBlockDraft, PanelMessage, StoredChannels } from './delivery';
import { deliveryError } from './delivery';
import { nextSubscriptionRun } from './schedule';

const { panelDashboardTiles, panelDashboards, panelProjects, panelReports, panelSubscriptions } = schema;

/** Most report tiles of a dashboard one message carries. */
export const MAX_DIGEST_TILES = 12;
const MAX_ROWS = 10;

// ---------------------------------------------------------------------------
// Rows and DTOs
// ---------------------------------------------------------------------------

export function storedChannelsOf(s: Pick<PanelSubscription, 'channels' | 'slackWebhookCiphertext'>): StoredChannels {
  return { channels: s.channels, slackWebhookCiphertext: s.slackWebhookCiphertext };
}

export function deliveryTargetOf(s: PanelSubscription): DeliveryTarget {
  return { channels: s.channels, slackWebhookCiphertext: s.slackWebhookCiphertext, ownerUserId: s.ownerUserId };
}

export function scheduleOf(s: Pick<PanelSubscription, 'schedule'>) {
  const parsed = panelSubscriptionScheduleSchema.safeParse(s.schedule);
  return parsed.success ? parsed.data : null;
}

export function toSubscriptionDto(s: PanelSubscription): PanelSubscriptionDto {
  return {
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    targetType: s.targetType,
    targetId: s.targetId,
    schedule: scheduleOf(s) ?? { frequency: 'daily', hour: 9, timezone: 'UTC' },
    channels: {
      emailUserIds: [...s.channels.emailUserIds],
      inApp: s.channels.inApp,
      slack: s.slackWebhookCiphertext !== null,
      weldchatChannelId: s.channels.weldchatChannelId ?? null,
    },
    enabled: s.enabled,
    nextRunAt: s.enabled ? (s.nextRunAt?.toISOString() ?? null) : null,
    lastRunAt: s.lastRunAt?.toISOString() ?? null,
    lastError: s.lastError,
    ownerUserId: s.ownerUserId,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** The entity-event payload: never the channels. */
export function subscriptionEventData(s: PanelSubscription) {
  return { id: s.id, projectId: s.projectId, name: s.name, targetType: s.targetType, targetId: s.targetId, schedule: s.schedule, enabled: s.enabled };
}

/** When a subscription next goes out; null when it is off. */
export function nextRunOf(s: Pick<PanelSubscription, 'enabled' | 'deletedAt' | 'schedule'>, now: Date): Date | null {
  const schedule = scheduleOf(s);
  if (!s.enabled || s.deletedAt || !schedule) return null;
  return nextSubscriptionRun(schedule, now);
}

export async function listSubscriptions(
  db: Database,
  params: { projectId?: string; targetType?: 'report' | 'dashboard'; targetId?: string; ownerUserId?: string },
): Promise<PanelSubscription[]> {
  const conds: SQL[] = [isNull(panelSubscriptions.deletedAt)];
  if (params.projectId) conds.push(eq(panelSubscriptions.projectId, params.projectId));
  if (params.targetType) conds.push(eq(panelSubscriptions.targetType, params.targetType));
  if (params.targetId) conds.push(eq(panelSubscriptions.targetId, params.targetId));
  if (params.ownerUserId) conds.push(eq(panelSubscriptions.ownerUserId, params.ownerUserId));
  return db.select().from(panelSubscriptions).where(and(...conds)).orderBy(desc(panelSubscriptions.updatedAt)).limit(500);
}

export async function getSubscription(db: Database, id: string): Promise<PanelSubscription | null> {
  const [row] = await db.select().from(panelSubscriptions).where(and(eq(panelSubscriptions.id, id), isNull(panelSubscriptions.deletedAt))).limit(1);
  return row ?? null;
}

export async function createSubscription(
  db: Database,
  input: ParsedCreatePanelSubscription,
  stored: StoredChannels,
  userId: string,
  now: Date,
): Promise<PanelSubscription> {
  const id = generateId('pnsb');
  const [row] = await db
    .insert(panelSubscriptions)
    .values({
      id,
      projectId: input.projectId,
      name: input.name,
      targetType: input.targetType,
      targetId: input.targetId,
      schedule: input.schedule as unknown as Record<string, unknown>,
      channels: stored.channels,
      slackWebhookCiphertext: stored.slackWebhookCiphertext,
      enabled: input.enabled,
      nextRunAt: input.enabled ? nextSubscriptionRun(input.schedule, now) : null,
      ownerUserId: userId,
    })
    .returning();
  return row as PanelSubscription;
}

export async function updateSubscription(
  db: Database,
  existing: PanelSubscription,
  input: ParsedUpdatePanelSubscription,
  stored: StoredChannels | null,
  now: Date,
): Promise<PanelSubscription | null> {
  const next = { ...existing, ...(input.schedule && { schedule: input.schedule as unknown as Record<string, unknown> }), ...(input.enabled !== undefined && { enabled: input.enabled }) };
  const [row] = await db
    .update(panelSubscriptions)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.schedule !== undefined && { schedule: input.schedule as unknown as Record<string, unknown> }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(stored && { channels: stored.channels, slackWebhookCiphertext: stored.slackWebhookCiphertext }),
      nextRunAt: nextRunOf(next, now),
      updatedAt: now,
    })
    .where(and(eq(panelSubscriptions.id, existing.id), isNull(panelSubscriptions.deletedAt)))
    .returning();
  return row ?? null;
}

export async function deleteSubscription(db: Database, id: string): Promise<PanelSubscription | null> {
  const [row] = await db
    .update(panelSubscriptions)
    .set({ deletedAt: new Date(), updatedAt: new Date(), enabled: false, nextRunAt: null })
    .where(and(eq(panelSubscriptions.id, id), isNull(panelSubscriptions.deletedAt)))
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export async function loadReport(db: Database, id: string): Promise<PanelReport | null> {
  const [row] = await db.select().from(panelReports).where(and(eq(panelReports.id, id), isNull(panelReports.deletedAt))).limit(1);
  return row ?? null;
}

export async function loadDashboard(db: Database, id: string): Promise<PanelDashboard | null> {
  const [row] = await db.select().from(panelDashboards).where(and(eq(panelDashboards.id, id), isNull(panelDashboards.deletedAt))).limit(1);
  return row ?? null;
}

const BUILDER_PATHS: Record<string, string> = {
  web: '/weldpanel',
  trends: '/weldpanel/insights',
  funnel: '/weldpanel/funnels',
  retention: '/weldpanel/retention',
  flows: '/weldpanel/flows',
};

/** Where a member opens a report (its builder, `?report=`). */
export function reportPath(report: Pick<PanelReport, 'id' | 'kind'>): string {
  return `${BUILDER_PATHS[report.kind] ?? '/weldpanel/insights'}?report=${encodeURIComponent(report.id)}`;
}

export function dashboardPath(id: string): string {
  return `/weldpanel/dashboards/${encodeURIComponent(id)}`;
}

const filterList = z.array(panelFilterSchema).max(20);

/**
 * A saved report's spec as the digest runs it: `compare` on for web and trends
 * (the change against the period before), the dashboard's date range and
 * filters on top when it has them. Null when the spec no longer parses.
 */
export function digestSpec(rawSpec: unknown, dashboardFilters?: PanelDashboard['filters']): ParsedPanelQuerySpec | null {
  const parsed = panelQuerySpecSchema.safeParse(rawSpec);
  if (!parsed.success) return null;
  const raw: Record<string, unknown> = { ...parsed.data };
  if (raw.kind === 'web' || raw.kind === 'trends') raw.compare = true;
  if (dashboardFilters) {
    const range = panelDateRangeSchema.safeParse(dashboardFilters.dateRange);
    if (range.success) raw.dateRange = range.data;
    const extra = filterList.safeParse(dashboardFilters.filters ?? []);
    if (extra.success && extra.data.length > 0 && Array.isArray(raw.filters)) raw.filters = [...(raw.filters as unknown[]), ...extra.data].slice(0, 20);
  }
  const again = panelQuerySpecSchema.safeParse(raw);
  return again.success ? again.data : null;
}

// ---------------------------------------------------------------------------
// Turning results into blocks
// ---------------------------------------------------------------------------

type Labels = ReturnType<typeof emailStrings>['panel']['reportDigest']['labels'];

interface BlockShape {
  headline: DigestBlockDraft['headline'];
  rows: DigestBlockDraft['rows'];
  /** The rows' title when the block stands alone (a report subscription). */
  rowsTitle: string;
  openOnly?: boolean;
}

/** The headline figures and top rows of one result. Pure. */
export function resultShape(result: PanelQueryResult, labels: Labels): BlockShape {
  switch (result.kind) {
    case 'web': {
      const { totals, previousTotals: prev, topPages } = result.result;
      return {
        rowsTitle: labels.topPages,
        headline: [
          { label: labels.visitors, value: totals.visitors, previous: prev?.visitors ?? null, format: 'number' },
          { label: labels.visits, value: totals.visits, previous: prev?.visits ?? null, format: 'number' },
          { label: labels.pageviews, value: totals.pageviews, previous: prev?.pageviews ?? null, format: 'number' },
          { label: labels.bounceRate, value: totals.bounceRate, previous: prev?.bounceRate ?? null, format: 'percent' },
        ],
        rows: topPages.slice(0, MAX_ROWS).map((row) => ({ label: row.value, value: row.visitors, format: 'number' as const })),
      };
    }
    case 'trends': {
      const lines = result.result.series;
      const totals = lines.filter((line) => line.breakdownValue === null);
      const broken = lines.filter((line) => line.breakdownValue !== null && line.seriesIndex === 0);
      return {
        rowsTitle: labels.breakdown,
        headline: totals.map((line) => ({ label: line.label, value: line.total, previous: line.previous?.total ?? null, format: 'number' as const })),
        rows: [...broken]
          .sort((a, b) => b.total - a.total)
          .slice(0, MAX_ROWS)
          .map((line) => ({ label: line.breakdownValue ?? '', value: line.total, format: 'number' as const })),
      };
    }
    case 'funnel':
      return {
        rowsTitle: labels.steps,
        headline: [{ label: labels.conversion, value: result.result.overallConversion, previous: null, format: 'percent' }],
        rows: result.result.steps.slice(0, MAX_ROWS).map((step) => ({ label: step.label || step.event, value: step.count, format: 'number' as const })),
      };
    case 'retention': {
      const avg = result.result.averageRetention;
      const size = result.result.cohorts.reduce((sum, c) => sum + c.size, 0);
      return {
        rowsTitle: labels.periods,
        headline: [
          { label: labels.cohortSize, value: size, previous: null, format: 'number' },
          ...(avg.length > 1 ? [{ label: labels.retained, value: avg[1] ?? 0, previous: null, format: 'percent' as const }] : []),
        ],
        rows: avg.slice(1, 1 + Math.min(MAX_ROWS, 6)).map((share, i) => ({ label: fill(labels.period, { n: i + 1 }), value: share, format: 'percent' as const })),
      };
    }
    case 'flows':
      return {
        rowsTitle: result.result.anchor,
        headline: [{ label: result.result.anchor, value: result.result.anchorCount, previous: null, format: 'number' }],
        rows: result.result.paths.slice(0, MAX_ROWS).map((path) => ({ label: path.steps.map((s) => s ?? '–').join(' → '), value: path.count, format: 'number' as const })),
      };
    default:
      return { rowsTitle: '', headline: [], rows: [], openOnly: true };
  }
}

/** One report's part of a digest, before it is written in a locale. */
export interface ComputedBlock {
  title: string;
  path: string;
  result: PanelQueryResult | null;
  failed: boolean;
}

export function blockDraft(block: ComputedBlock, locale: EmailLocale, standalone: boolean): DigestBlockDraft {
  if (block.failed || !block.result) return { title: block.title, headline: [], rows: [], failed: true, path: block.path };
  const shape = resultShape(block.result, emailStrings(locale).panel.reportDigest.labels);
  return {
    title: standalone ? shape.rowsTitle || block.title : block.title,
    headline: shape.headline,
    rows: shape.rows,
    ...(shape.openOnly && { openOnly: true }),
    path: block.path,
  };
}

export interface DigestDeps {
  db: Database;
  run: (spec: ParsedPanelQuerySpec) => Promise<PanelQueryResult>;
}

async function computeBlock(deps: DigestDeps, report: PanelReport, filters?: PanelDashboard['filters']): Promise<ComputedBlock> {
  const block = { title: report.name, path: reportPath(report) };
  const spec = digestSpec(report.spec, filters);
  if (!spec || spec.projectId !== report.projectId) return { ...block, result: null, failed: true };
  try {
    return { ...block, result: await deps.run(spec), failed: false };
  } catch (err) {
    console.warn(`[panel-api] scheduled report ${report.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ...block, result: null, failed: true };
  }
}

export type DigestOutcome = { ok: true; message: PanelMessage } | { ok: false; reason: string };

/** Runs the subscription's report (or the dashboard's report tiles) and builds the message. */
export async function buildDigest(deps: DigestDeps, sub: PanelSubscription): Promise<DigestOutcome> {
  const { db } = deps;
  const [project] = await db.select({ name: panelProjects.name }).from(panelProjects).where(and(eq(panelProjects.id, sub.projectId), isNull(panelProjects.deletedAt))).limit(1);
  if (!project) return { ok: false, reason: 'The project was deleted' };

  let targetName: string;
  let path: string;
  let blocks: ComputedBlock[];
  let moreCount = 0;
  if (sub.targetType === 'report') {
    const report = await loadReport(db, sub.targetId);
    if (!report || report.projectId !== sub.projectId) return { ok: false, reason: 'The report was deleted' };
    targetName = report.name;
    path = reportPath(report);
    blocks = [await computeBlock(deps, report)];
  } else {
    const dashboard = await loadDashboard(db, sub.targetId);
    if (!dashboard || dashboard.projectId !== sub.projectId) return { ok: false, reason: 'The dashboard was deleted' };
    targetName = dashboard.name;
    path = dashboardPath(dashboard.id);
    const tiles = await db.select().from(panelDashboardTiles).where(eq(panelDashboardTiles.dashboardId, dashboard.id));
    const reportTiles = tiles
      .filter((t) => t.kind !== 'text' && t.reportId)
      .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
    const ids = reportTiles.map((t) => t.reportId as string);
    const reports = ids.length
      ? await db.select().from(panelReports).where(and(inArray(panelReports.id, ids), eq(panelReports.projectId, sub.projectId), isNull(panelReports.deletedAt)))
      : [];
    const byId = new Map(reports.map((r) => [r.id, r]));
    const ordered = ids.map((id) => byId.get(id)).filter((r): r is PanelReport => Boolean(r));
    moreCount = Math.max(0, ordered.length - MAX_DIGEST_TILES);
    blocks = [];
    for (const report of ordered.slice(0, MAX_DIGEST_TILES)) blocks.push(await computeBlock(deps, report, dashboard.filters));
  }

  const standalone = sub.targetType === 'report';
  return {
    ok: true,
    message: {
      kind: 'report',
      entityId: sub.id,
      path,
      digest: (locale) => ({
        subscriptionName: sub.name,
        projectName: project.name,
        targetType: sub.targetType,
        targetName,
        blocks: blocks.map((b) => blockDraft(b, locale, standalone)),
        ...(moreCount > 0 && { moreCount }),
      }),
    },
  };
}

export interface SendDeps extends DigestDeps {
  deliver: (target: DeliveryTarget, message: PanelMessage) => Promise<PanelDeliveryResult[]>;
  now: Date;
}

/**
 * Builds and sends the subscription now, and records the run (`lastRunAt`,
 * `lastError`). With `schedule: true` (the cron), also moves `nextRunAt` on.
 */
export async function sendSubscription(deps: SendDeps, sub: PanelSubscription, options: { schedule: boolean }): Promise<{ delivered: PanelDeliveryResult[]; error: string | null; subscription: PanelSubscription }> {
  const digest = await buildDigest(deps, sub);
  const delivered = digest.ok ? await deps.deliver(deliveryTargetOf(sub), digest.message) : [];
  const error = digest.ok ? deliveryError(delivered) : digest.reason;
  const [row] = await deps.db
    .update(panelSubscriptions)
    .set({
      lastRunAt: deps.now,
      lastError: error,
      ...(options.schedule && { nextRunAt: nextRunOf(sub, deps.now) }),
      updatedAt: deps.now,
    })
    .where(eq(panelSubscriptions.id, sub.id))
    .returning();
  return { delivered, error, subscription: row ?? sub };
}
