/**
 * The suppression list: /api/reach/suppressions
 *
 * Permissions: reach_settings:read (list), reach_settings:update (add, delete).
 * Adding entries stops the matching prospects' queued and active enrollments;
 * removing one lets a prospect be enrolled again. No entity events for the
 * entries: the list is a compliance record, not a catalogued entity (a campaign
 * that runs out of prospects because of one still publishes `completed`).
 * The logic is in `@weldsuite/reach-domain/suppressions`, shared with the public API.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, list, noContent, success } from '@weldsuite/worker-kit/response';
import { addReachSuppressionsSchema } from '@weldsuite/app-api-client/schemas/reach';
import type { ReachEventSink } from '@weldsuite/reach-domain/events';
import { addManualSuppressions, listSuppressions, removeSuppression } from '@weldsuite/reach-domain/suppressions';
import type { Env, Variables } from '../../types';
import { reachErrorHandler } from '../../services/reach-errors';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.onError(reachErrorHandler);

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Entity events of this request (`reach_campaign:completed`). */
function requestSink(c: AppContext): ReachEventSink {
  return (event) => {
    publishEntityEvent({
      c,
      entityType: event.entityType,
      action: event.action,
      entityId: event.entityId,
      data: event.data,
      changes: event.changes ?? undefined,
    });
  };
}

app.get('/', requirePermission('reach_settings:read'), async (c) => {
  const page = await listSuppressions(c.get('tenantDb'), c.req.query());
  return list(c, page.data, cursorPagination(page.totalCount, page.hasMore, page.cursor));
});

app.post('/', requirePermission('reach_settings:update'), zValidator('json', addReachSuppressionsSchema), async (c) => {
  const result = await addManualSuppressions(
    { db: c.get('tenantDb'), emit: requestSink(c), userId: c.get('userId') },
    c.req.valid('json').values,
  );
  return success(c, result, 201);
});

app.delete('/:id', requirePermission('reach_settings:update'), async (c) => {
  await removeSuppression(c.get('tenantDb'), c.req.param('id'));
  return noContent(c);
});

export default app;
