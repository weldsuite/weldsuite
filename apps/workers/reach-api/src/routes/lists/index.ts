/**
 * Prospect lists: /api/reach/lists
 *
 * Permissions: reach_prospects:read | create | update | delete.
 * Lists are organisation only (no entity-event type exists for them); the
 * prospects themselves publish `reach_prospect` events. The logic is in
 * `@weldsuite/reach-domain/lists`, shared with the public API.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createReachListSchema,
  reachListMembersSchema,
  updateReachListSchema,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  addProspectListMembers,
  createProspectList,
  deleteProspectList,
  getProspectList,
  listProspectLists,
  removeProspectListMembers,
  updateProspectList,
} from '@weldsuite/reach-domain/lists';
import type { Env, Variables } from '../../types';
import { reachErrorHandler } from '../../services/reach-errors';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.onError(reachErrorHandler);

app.get('/', requirePermission('reach_prospects:read'), async (c) => {
  const page = await listProspectLists(c.get('tenantDb'), c.req.query());
  return list(c, page.data, cursorPagination(page.totalCount, page.hasMore, page.cursor));
});

app.get('/:id', requirePermission('reach_prospects:read'), async (c) => {
  return success(c, await getProspectList(c.get('tenantDb'), c.req.param('id')));
});

app.post('/', requirePermission('reach_prospects:create'), zValidator('json', createReachListSchema), async (c) => {
  return success(c, await createProspectList(c.get('tenantDb'), c.req.valid('json'), c.get('userId')), 201);
});

app.patch('/:id', requirePermission('reach_prospects:update'), zValidator('json', updateReachListSchema), async (c) => {
  return success(c, await updateProspectList(c.get('tenantDb'), c.req.param('id'), c.req.valid('json')));
});

app.delete('/:id', requirePermission('reach_prospects:delete'), async (c) => {
  await deleteProspectList(c.get('tenantDb'), c.req.param('id'));
  return noContent(c);
});

app.post('/:id/members', requirePermission('reach_prospects:update'), zValidator('json', reachListMembersSchema), async (c) => {
  return success(c, await addProspectListMembers(c.get('tenantDb'), c.req.param('id'), c.req.valid('json').prospectIds));
});

app.post('/:id/members/remove', requirePermission('reach_prospects:update'), zValidator('json', reachListMembersSchema), async (c) => {
  return success(c, await removeProspectListMembers(c.get('tenantDb'), c.req.param('id'), c.req.valid('json').prospectIds));
});

export default app;
