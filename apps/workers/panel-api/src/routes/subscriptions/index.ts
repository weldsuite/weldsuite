/**
 * Scheduled reports: /api/panel/subscriptions/*. A saved report or dashboard
 * sent daily, weekly or monthly, at an hour in a timezone, by email, in-app,
 * Slack or WeldChat; panel-api's cron sends it (./scheduled.ts).
 *
 *   GET    /                → subscriptions (?projectId, ?targetType, ?targetId, ?scope=all|mine)
 *   POST   /                → new subscription
 *   GET    /:id             → one subscription
 *   PATCH  /:id             → name, schedule, channels, enabled
 *   DELETE /:id             → soft delete
 *   POST   /:id/send-now    → deliver now, outside the schedule
 *
 * Permissions and ownership like alerts: `panel_reports:read` to see,
 * `panel_reports:create|update|delete` to change one's own, plus
 * `panel_projects:manage` for someone else's. The target must be a report or
 * dashboard of the project that the caller can see. Mutations publish
 * `panel_subscription` entity events without the channels.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  PANEL_SUBSCRIPTION_TARGETS,
  createPanelSubscriptionSchema,
  updatePanelSubscriptionSchema,
  type PanelDeliveryReportDto,
} from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import type { PanelSubscription } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { canChange, canSee, getDashboard, getReport, projectExists, type Actor } from '../../services/saved-objects';
import {
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  sendSubscription,
  storedChannelsOf,
  subscriptionEventData,
  toSubscriptionDto,
  updateSubscription,
} from '../../services/subscriptions';
import { channelsProblem, deliver, storeChannels } from '../../services/delivery';
import { deleteSchedule, upsertSchedule } from '../../services/schedule';
import { SecretsUnavailableError } from '../../services/secrets';
import { runCachedQuery, queryRunDeps } from '../../services/query-run';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({
  projectId: z.string().min(1).max(30).optional(),
  targetType: z.enum(PANEL_SUBSCRIPTION_TARGETS).optional(),
  targetId: z.string().min(1).max(30).optional(),
  scope: z.enum(['all', 'mine']).optional(),
});

async function actorOf(c: Ctx): Promise<Actor> {
  return { userId: c.get('userId'), canManage: await hasContextPermission(c, 'panel_projects:manage') };
}

function mayChange(sub: PanelSubscription, actor: Actor): boolean {
  return canChange({ ownerUserId: sub.ownerUserId, visibility: 'workspace' }, actor);
}

function publish(c: Ctx, sub: PanelSubscription, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_subscription', entityId: sub.id, action, data: subscriptionEventData(sub) });
}

/** Keeps the cron's registry row in step with the subscription's `nextRunAt`. */
async function reschedule(c: Ctx, sub: PanelSubscription): Promise<void> {
  await upsertSchedule(getMasterDb(c.env), { workspaceId: c.get('workspaceId'), kind: 'subscription', objectId: sub.id, nextRunAt: sub.nextRunAt });
}

/** A report or dashboard of the project that the caller can see; null when it is not one. */
async function visibleTarget(c: Ctx, actor: Actor, projectId: string, targetType: 'report' | 'dashboard', targetId: string): Promise<boolean> {
  const db = c.get('tenantDb');
  const target = targetType === 'report' ? await getReport(db, targetId) : await getDashboard(db, targetId);
  return Boolean(target && target.projectId === projectId && canSee(target, actor));
}

app.get('/', requirePermission('panel_reports:read'), zValidator('query', listQuery), async (c) => {
  const { scope, ...params } = c.req.valid('query');
  const subs = await listSubscriptions(c.get('tenantDb'), { ...params, ownerUserId: scope === 'mine' ? c.get('userId') : undefined });
  return list(c, subs.map(toSubscriptionDto), cursorPagination(subs.length, false, null));
});

app.post('/', requirePermission('panel_reports:create'), zValidator('json', createPanelSubscriptionSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  if (!(await projectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);
  if (!(await visibleTarget(c, await actorOf(c), input.projectId, input.targetType, input.targetId))) {
    return error.notFound(c, input.targetType === 'report' ? 'Report' : 'Dashboard', input.targetId);
  }
  const problem = await channelsProblem(db, input.channels);
  if (problem) return error.badRequest(c, problem);

  let stored;
  try {
    stored = await storeChannels(c.env, input.channels);
  } catch (err) {
    if (err instanceof SecretsUnavailableError) return error.unavailable(c, err.message);
    throw err;
  }
  const sub = await createSubscription(db, input, stored, userId, new Date());
  await reschedule(c, sub);
  publish(c, sub, 'created');
  return success(c, toSubscriptionDto(sub), 201);
});

app.get('/:id', requirePermission('panel_reports:read'), async (c) => {
  const id = c.req.param('id');
  const sub = await getSubscription(c.get('tenantDb'), id);
  if (!sub) return error.notFound(c, 'Subscription', id);
  return success(c, toSubscriptionDto(sub));
});

app.patch('/:id', requirePermission('panel_reports:update'), zValidator('json', updatePanelSubscriptionSchema), async (c) => {
  const id = c.req.param('id');
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  const existing = await getSubscription(db, id);
  if (!existing) return error.notFound(c, 'Subscription', id);
  if (!mayChange(existing, await actorOf(c))) return error.forbidden(c, 'Only the owner can change this scheduled report');

  if (input.channels) {
    const problem = await channelsProblem(db, input.channels);
    if (problem) return error.badRequest(c, problem);
  }
  let stored = null;
  try {
    stored = input.channels ? await storeChannels(c.env, input.channels, storedChannelsOf(existing)) : null;
  } catch (err) {
    if (err instanceof SecretsUnavailableError) return error.unavailable(c, err.message);
    throw err;
  }
  const sub = await updateSubscription(db, existing, input, stored, new Date());
  if (!sub) return error.notFound(c, 'Subscription', id);
  await reschedule(c, sub);
  publish(c, sub, 'updated');
  return success(c, toSubscriptionDto(sub));
});

app.delete('/:id', requirePermission('panel_reports:delete'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const existing = await getSubscription(db, id);
  if (!existing) return error.notFound(c, 'Subscription', id);
  if (!mayChange(existing, await actorOf(c))) return error.forbidden(c, 'Only the owner can delete this scheduled report');

  const sub = await deleteSubscription(db, id);
  if (!sub) return error.notFound(c, 'Subscription', id);
  await deleteSchedule(getMasterDb(c.env), { kind: 'subscription', objectId: id });
  publish(c, sub, 'deleted');
  return noContent(c);
});

app.post('/:id/send-now', requirePermission('panel_reports:update'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const sub = await getSubscription(db, id);
  if (!sub) return error.notFound(c, 'Subscription', id);
  if (!mayChange(sub, await actorOf(c))) return error.forbidden(c, 'Only the owner can send this scheduled report');

  const workspaceId = c.get('workspaceId');
  const runDeps = queryRunDeps(c.env, db, workspaceId);
  const result = await sendSubscription(
    {
      db,
      now: new Date(),
      run: async (spec) => (await runCachedQuery(runDeps, spec)).result,
      deliver: (target, message) => deliver({ env: c.env, db, workspaceId, clerkOrgId: c.get('clerkOrgId') ?? workspaceId, actorUserId: userId }, target, message),
    },
    sub,
    { schedule: false },
  );
  if (result.error && result.delivered.length === 0) return error.badRequest(c, result.error);
  const body: PanelDeliveryReportDto = { delivered: result.delivered };
  return success(c, body);
});

export default app;
