/**
 * Prospects: /api/reach/prospects
 *
 * Permissions: reach_prospects:read | create | update | delete. The CRM and
 * WeldData imports also need read access to the source (lists:read, plus
 * people:read for a CRM list).
 *
 * Imports store every parseable row with a `validation` verdict, report the
 * rows that cannot be used and why, and publish `reach_prospect:created` for
 * the first MAX_IMPORT_EVENTS new prospects (a 5 000-row import must not become
 * 5 000 queue messages inside one request).
 *
 * The logic is in `@weldsuite/reach-domain/prospects`, shared with the public
 * API; this file maps requests to it and wires its event port.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  importReachFromCrmListSchema,
  importReachFromWeldDataSchema,
  importReachProspectsSchema,
  reachProspectInputSchema,
  resolveWeldReachLimits,
  updateReachProspectSchema,
} from '@weldsuite/app-api-client/schemas/reach';
import type { ReachEventSink } from '@weldsuite/reach-domain/events';
import {
  createProspect,
  deleteProspect,
  getProspect,
  importProspectRows,
  importProspectsFromCrmList,
  importProspectsFromWeldDataList,
  listProspects,
  updateProspect,
} from '@weldsuite/reach-domain/prospects';
import type { Env, Variables } from '../../types';
import { reachErrorHandler } from '../../services/reach-errors';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.onError(reachErrorHandler);

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Entity events of this request. The entity-event coverage sweep reads this file, so the publish call is spelled out here. */
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

/** appAccessGate sets `appAccess`; the optional chain keeps route tests that skip the gate working. */
function depsOf(c: AppContext) {
  return {
    db: c.get('tenantDb'),
    emit: requestSink(c),
    userId: c.get('userId'),
    limits: resolveWeldReachLimits(c.get('appAccess')?.limits),
  };
}

app.get('/', requirePermission('reach_prospects:read'), async (c) => {
  const page = await listProspects(c.get('tenantDb'), c.req.query());
  return list(c, page.data, cursorPagination(page.totalCount, page.hasMore, page.cursor));
});

app.get('/:id', requirePermission('reach_prospects:read'), async (c) => {
  return success(c, await getProspect(c.get('tenantDb'), c.req.param('id')));
});

app.post(
  '/',
  requirePermission('reach_prospects:create'),
  zValidator('json', reachProspectInputSchema.extend({ listId: z.string().min(1).max(30).optional() })),
  async (c) => {
    return success(c, await createProspect(depsOf(c), c.req.valid('json')), 201);
  },
);

app.patch('/:id', requirePermission('reach_prospects:update'), zValidator('json', updateReachProspectSchema), async (c) => {
  return success(c, await updateProspect(depsOf(c), c.req.param('id'), c.req.valid('json')));
});

app.delete('/:id', requirePermission('reach_prospects:delete'), async (c) => {
  await deleteProspect(depsOf(c), c.req.param('id'));
  return noContent(c);
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

app.post('/import', requirePermission('reach_prospects:create'), zValidator('json', importReachProspectsSchema), async (c) => {
  return success(c, await importProspectRows(depsOf(c), c.req.valid('json')));
});

app.post(
  '/import-crm-list',
  requirePermission('reach_prospects:create'),
  zValidator('json', importReachFromCrmListSchema),
  async (c) => {
    if (!(await hasContextPermission(c, 'lists:read')) || !(await hasContextPermission(c, 'people:read'))) {
      return error.forbidden(c, 'Importing a CRM list needs read access to CRM lists and people');
    }
    return success(c, await importProspectsFromCrmList(depsOf(c), c.req.valid('json')));
  },
);

app.post(
  '/import-welddata',
  requirePermission('reach_prospects:create'),
  zValidator('json', importReachFromWeldDataSchema),
  async (c) => {
    if (!(await hasContextPermission(c, 'lists:read'))) {
      return error.forbidden(c, 'Importing a WeldData list needs read access to its lists');
    }
    return success(c, await importProspectsFromWeldDataList(depsOf(c), c.req.valid('json')));
  },
);

export default app;
