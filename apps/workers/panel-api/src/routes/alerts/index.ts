/**
 * Alerts: /api/panel/alerts/*. An alert watches one series of a trends query
 * (a saved trends report or a spec of its own) and messages its channels when
 * it fires and when it resolves; panel-api's cron checks it (./scheduled.ts).
 *
 *   GET    /             → the project's alerts (?projectId, ?scope=all|mine)
 *   POST   /             → new alert
 *   GET    /:id          → one alert
 *   PATCH  /:id          → name, target, series, condition, interval, channels, enabled
 *   DELETE /:id          → soft delete
 *   GET    /:id/events   → history: fired, resolved, failed checks (?cursor, ?limit)
 *   POST   /:id/test     → a test message on every channel
 *   POST   /:id/snooze   → { until } (ISO, at most 90 days ahead; null ends it)
 *
 * Reading is `panel_reports:read` (every member who can read reports sees the
 * project's alerts); writing is `panel_reports:create|update|delete`, and
 * changing someone else's alert also needs `panel_projects:manage`. The Slack
 * webhook URL is write-only (`channels.slack: true` in the DTO). Mutations
 * publish `panel_alert` entity events without channels or spec; the cron
 * publishes `fired` and `resolved`.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  PANEL_MAX_SNOOZE_DAYS,
  createPanelAlertSchema,
  snoozePanelAlertSchema,
  updatePanelAlertSchema,
  type PanelDeliveryReportDto,
  type ParsedPanelDeliveryChannels,
  type ParsedUpdatePanelAlert,
} from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import type { ParsedTrendsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelAlert } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { canChange, canSee, getReport, projectExists, type Actor } from '../../services/saved-objects';
import {
  alertEventData,
  alertMessage,
  createAlert,
  deleteAlert,
  deliveryTargetOf,
  getAlert,
  listAlertEvents,
  listAlerts,
  nextCheckOf,
  parseTrendsSpec,
  projectName,
  resolveAlertSpec,
  seriesLabel,
  snoozeAlert,
  storedChannelsOf,
  toAlertDto,
  toAlertEventDto,
  updateAlert,
} from '../../services/alerts';
import { channelsProblem, deliver, storeChannels, type StoredChannels } from '../../services/delivery';
import { deleteSchedule, nextRunsOf, upsertSchedule } from '../../services/schedule';
import { SecretsUnavailableError } from '../../services/secrets';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({
  projectId: z.string().min(1).max(30).optional(),
  scope: z.enum(['all', 'mine']).optional(),
});

const pageQuery = z.object({
  cursor: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

async function actorOf(c: Ctx): Promise<Actor> {
  return { userId: c.get('userId'), canManage: await hasContextPermission(c, 'panel_projects:manage') };
}

/** Alerts have no private/shared switch: everyone may see them, the owner (or a manager) changes them. */
function mayChange(alert: PanelAlert, actor: Actor): boolean {
  return canChange({ ownerUserId: alert.ownerUserId, visibility: 'workspace' }, actor);
}

function publish(c: Ctx, alert: PanelAlert, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_alert', entityId: alert.id, action, data: alertEventData(alert) });
}

async function dto(c: Ctx, alert: PanelAlert) {
  const next = await nextRunsOf(getMasterDb(c.env), 'alert', [alert.id]);
  return toAlertDto(alert, next.get(alert.id) ?? null);
}

/** Writes when the cron next checks the alert (or removes it when it is off). */
async function reschedule(c: Ctx, alert: PanelAlert, timezone: string): Promise<void> {
  const workspaceId = c.get('workspaceId');
  await upsertSchedule(getMasterDb(c.env), { workspaceId, kind: 'alert', objectId: alert.id, nextRunAt: nextCheckOf(alert, timezone, new Date()) });
}

type TargetCheck = { ok: true; spec: ParsedTrendsSpec } | { ok: false; response: Response };

/** The alert's target as given: a trends report the caller can see, or a trends spec, of this project, with the series. */
async function checkTarget(c: Ctx, actor: Actor, projectId: string, target: { reportId?: string | null; spec?: unknown }, seriesIndex: number): Promise<TargetCheck> {
  const db = c.get('tenantDb');
  let spec: ParsedTrendsSpec;
  if (target.reportId) {
    const report = await getReport(db, target.reportId);
    if (!report || !canSee(report, actor)) return { ok: false, response: error.notFound(c, 'Report', target.reportId) };
    if (report.projectId !== projectId) return { ok: false, response: error.badRequest(c, 'The report is in a different project') };
    if (report.kind !== 'trends') return { ok: false, response: error.badRequest(c, 'An alert watches a trends report') };
    const parsed = parseTrendsSpec(report.spec, projectId);
    if (!parsed.ok) return { ok: false, response: error.badRequest(c, parsed.reason) };
    spec = parsed.spec;
  } else {
    const parsed = parseTrendsSpec(target.spec, projectId);
    if (!parsed.ok) return { ok: false, response: error.badRequest(c, parsed.reason) };
    spec = parsed.spec;
  }
  if (seriesIndex >= spec.series.length) return { ok: false, response: error.badRequest(c, 'The query has no such series') };
  return { ok: true, spec };
}

/**
 * The target after an update, checked when it or the series changes; null when
 * neither did (a target kept is used as stored: its report may since have
 * become someone else's private one).
 */
async function patchedTarget(c: Ctx, actor: Actor, existing: PanelAlert, input: ParsedUpdatePanelAlert): Promise<TargetCheck | null> {
  const retarget = input.reportId !== undefined || input.spec !== undefined;
  if (!retarget && input.seriesIndex === undefined) return null;
  const reportId = retarget ? (input.reportId ?? null) : existing.reportId;
  const spec = retarget ? (input.spec ?? null) : existing.spec;
  if (!reportId && !spec) return { ok: false, response: error.badRequest(c, 'Give either a report or a spec') };
  return checkTarget(c, actor, existing.projectId, { reportId, spec }, input.seriesIndex ?? existing.seriesIndex);
}

/** Channels as stored (the Slack URL sealed), or the refusal: a non-member recipient, a missing channel, no key to seal with. */
async function channelsFor(c: Ctx, input: ParsedPanelDeliveryChannels, existing?: StoredChannels): Promise<StoredChannels | Response> {
  const problem = await channelsProblem(c.get('tenantDb'), input);
  if (problem) return error.badRequest(c, problem);
  try {
    return await storeChannels(c.env, input, existing);
  } catch (err) {
    if (err instanceof SecretsUnavailableError) return error.unavailable(c, err.message);
    throw err;
  }
}

app.get('/', requirePermission('panel_reports:read'), zValidator('query', listQuery), async (c) => {
  const { projectId, scope } = c.req.valid('query');
  const alerts = await listAlerts(c.get('tenantDb'), { projectId, ownerUserId: scope === 'mine' ? c.get('userId') : undefined });
  const next = await nextRunsOf(getMasterDb(c.env), 'alert', alerts.map((a) => a.id));
  return list(c, alerts.map((a) => toAlertDto(a, next.get(a.id) ?? null)), cursorPagination(alerts.length, false, null));
});

app.post('/', requirePermission('panel_reports:create'), zValidator('json', createPanelAlertSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  if (!(await projectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  const target = await checkTarget(c, await actorOf(c), input.projectId, input, input.seriesIndex);
  if (!target.ok) return target.response;
  const stored = await channelsFor(c, input.channels);
  if (stored instanceof Response) return stored;
  const alert = await createAlert(db, input, stored, userId);
  await reschedule(c, alert, target.spec.timezone);
  publish(c, alert, 'created');
  return success(c, await dto(c, alert), 201);
});

app.get('/:id', requirePermission('panel_reports:read'), async (c) => {
  const id = c.req.param('id');
  const alert = await getAlert(c.get('tenantDb'), id);
  if (!alert) return error.notFound(c, 'Alert', id);
  return success(c, await dto(c, alert));
});

app.patch('/:id', requirePermission('panel_reports:update'), zValidator('json', updatePanelAlertSchema), async (c) => {
  const id = c.req.param('id');
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  const actor = await actorOf(c);
  const existing = await getAlert(db, id);
  if (!existing) return error.notFound(c, 'Alert', id);
  if (!mayChange(existing, actor)) return error.forbidden(c, 'Only the owner can change this alert');

  const target = await patchedTarget(c, actor, existing, input);
  if (target && !target.ok) return target.response;
  const stored = input.channels ? await channelsFor(c, input.channels, storedChannelsOf(existing)) : null;
  if (stored instanceof Response) return stored;

  const alert = await updateAlert(db, id, input, stored);
  if (!alert) return error.notFound(c, 'Alert', id);
  const resolved = target?.ok ? { ok: true as const, spec: target.spec } : await resolveAlertSpec(db, alert);
  await reschedule(c, alert, resolved.ok ? resolved.spec.timezone : 'UTC');
  publish(c, alert, 'updated');
  return success(c, await dto(c, alert));
});

app.delete('/:id', requirePermission('panel_reports:delete'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const existing = await getAlert(db, id);
  if (!existing) return error.notFound(c, 'Alert', id);
  if (!mayChange(existing, await actorOf(c))) return error.forbidden(c, 'Only the owner can delete this alert');

  const alert = await deleteAlert(db, id);
  if (!alert) return error.notFound(c, 'Alert', id);
  await deleteSchedule(getMasterDb(c.env), { kind: 'alert', objectId: id });
  publish(c, alert, 'deleted');
  return noContent(c);
});

app.get('/:id/events', requirePermission('panel_reports:read'), zValidator('query', pageQuery), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  if (!(await getAlert(db, id))) return error.notFound(c, 'Alert', id);
  const { cursor, limit = 50 } = c.req.valid('query');
  const rows = await listAlertEvents(db, id, cursor ? new Date(cursor) : null, limit + 1);
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return list(c, page.map(toAlertEventDto), cursorPagination(page.length, hasMore, hasMore ? page[page.length - 1]!.createdAt.toISOString() : null));
});

app.post('/:id/test', requirePermission('panel_reports:update'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const alert = await getAlert(db, id);
  if (!alert) return error.notFound(c, 'Alert', id);
  if (!mayChange(alert, await actorOf(c))) return error.forbidden(c, 'Only the owner can test this alert');

  const resolved = await resolveAlertSpec(db, alert);
  const message = alertMessage(alert, {
    event: 'test',
    metric: resolved.ok ? seriesLabel(resolved.spec, alert.seriesIndex) : alert.name,
    value: null,
    bound: null,
    interval: alert.checkInterval,
    period: null,
    projectName: await projectName(db, alert.projectId),
  });
  const workspaceId = c.get('workspaceId');
  const delivered = await deliver({ env: c.env, db, workspaceId, clerkOrgId: c.get('clerkOrgId') ?? workspaceId, actorUserId: userId }, deliveryTargetOf(alert), message);
  const body: PanelDeliveryReportDto = { delivered };
  return success(c, body);
});

app.post('/:id/snooze', requirePermission('panel_reports:update'), zValidator('json', snoozePanelAlertSchema), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const existing = await getAlert(db, id);
  if (!existing) return error.notFound(c, 'Alert', id);
  if (!mayChange(existing, await actorOf(c))) return error.forbidden(c, 'Only the owner can snooze this alert');

  const { until } = c.req.valid('json');
  const at = until ? new Date(until) : null;
  const now = Date.now();
  if (at && (at.getTime() <= now || at.getTime() > now + PANEL_MAX_SNOOZE_DAYS * 86_400_000)) {
    return error.badRequest(c, `Snooze until a time in the next ${PANEL_MAX_SNOOZE_DAYS} days`);
  }
  const alert = await snoozeAlert(db, id, at);
  if (!alert) return error.notFound(c, 'Alert', id);
  publish(c, alert, 'updated');
  return success(c, await dto(c, alert));
});

export default app;
