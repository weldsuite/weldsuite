/**
 * WeldChat subscriptions: /api/merge/chat-subscriptions.
 *
 *   GET    /       -> list (channelId, teamId)                     merge_teams:read
 *   POST   /       -> subscribe a channel to events                 merge_teams:manage
 *   PATCH  /:id    -> change team, repository, events, digest hour  merge_teams:manage
 *   DELETE /:id    -> unsubscribe (soft delete)                     merge_teams:manage
 *
 * The member must be able to open the channel they subscribe (an unknown or
 * private channel is a 404). A subscription with `daily_digest` marks the
 * workspace due in the `merge_digest` index at its next digest hour.
 *
 * Events: merge_chat_subscription created | updated | deleted.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { canAccessChannel } from '@weldsuite/chat-domain/channel-access';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createMergeChatSubscriptionSchema,
  listMergeChatSubscriptionsQuerySchema,
  updateMergeChatSubscriptionSchema,
} from '@weldsuite/app-api-client/schemas/weldmerge-across';
import type { Env, Variables } from '../../types';
import type { Ctx } from '../shared';
import { diffFields, publishEntityEvents, type PendingEvent } from '../../services/events';
import type { MergeChatSubscriptionRow } from '../../services/db';
import {
  SUBSCRIPTION_CHANGE_FIELDS,
  createSubscription,
  deleteSubscription,
  nextDigestAt,
  subscriptionDto,
  subscriptionEventData,
  updateSubscription,
  listSubscriptions,
  type SubscriptionRefFailure,
} from '../../services/chat/subscriptions';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function subscriptionEvent(
  row: MergeChatSubscriptionRow,
  action: 'created' | 'updated' | 'deleted',
  changes?: PendingEvent['changes'],
): PendingEvent {
  return { entityType: 'merge_chat_subscription', action, entityId: row.id, data: subscriptionEventData(row), changes };
}

/** A subscription with a daily digest makes the sweep look at this workspace at the digest hour. */
async function armDigest(c: Ctx, row: MergeChatSubscriptionRow): Promise<void> {
  if (!(row.events ?? []).includes('daily_digest')) return;
  await markWorkspaceDue(c.env.SCHEDULE_INDEX, 'merge_digest', c.get('clerkOrgId'), nextDigestAt(row.digestHour, new Date()));
}

const refFailure = (c: Ctx, reason: SubscriptionRefFailure) =>
  error.notFound(c, reason === 'team_not_found' ? 'Team' : 'Repository');

app.get('/', requirePermission('merge_teams:read'), zValidator('query', listMergeChatSubscriptionsQuerySchema), async (c) => {
  const rows = await listSubscriptions(c.get('tenantDb'), c.req.valid('query'));
  return list(c, rows.map(subscriptionDto), cursorPagination(rows.length, false, null));
});

app.post('/', requirePermission('merge_teams:manage'), zValidator('json', createMergeChatSubscriptionSchema), async (c) => {
  const db = c.get('tenantDb');
  const input = c.req.valid('json');
  if (!(await canAccessChannel(db, input.channelId, c.get('userId')))) return error.notFound(c, 'Channel', input.channelId);
  const result = await createSubscription(db, input, c.get('userId'));
  if (!result.ok) return refFailure(c, result.reason);
  publishEntityEvents(c, [subscriptionEvent(result.subscription, 'created')]);
  await armDigest(c, result.subscription);
  return success(c, subscriptionDto(result.subscription), 201);
});

app.patch('/:id', requirePermission('merge_teams:manage'), zValidator('json', updateMergeChatSubscriptionSchema), async (c) => {
  const id = c.req.param('id');
  const result = await updateSubscription(c.get('tenantDb'), id, c.req.valid('json'));
  if (!result.ok) {
    if (result.reason === 'not_found') return error.notFound(c, 'Chat subscription', id);
    return refFailure(c, result.reason);
  }
  const changes = diffFields(result.before, result.subscription, SUBSCRIPTION_CHANGE_FIELDS);
  publishEntityEvents(c, [subscriptionEvent(result.subscription, 'updated', changes)]);
  await armDigest(c, result.subscription);
  return success(c, subscriptionDto(result.subscription));
});

app.delete('/:id', requirePermission('merge_teams:manage'), async (c) => {
  const id = c.req.param('id');
  const row = await deleteSubscription(c.get('tenantDb'), id);
  if (!row) return error.notFound(c, 'Chat subscription', id);
  publishEntityEvents(c, [subscriptionEvent(row, 'deleted')]);
  return noContent(c);
});

export default app;
