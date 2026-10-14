/**
 * Prospect lists: /v1/reach/lists
 *
 * Scopes: reach_prospects:read (list, get) and reach_prospects:write (create,
 * update, delete, add and remove members). Lists are organisation only: no
 * entity-event type exists for them (the prospects publish `reach_prospect`
 * events). The same domain functions as reach-api's `/api/reach/lists`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
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
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { cursorPagination, list, noContent, success } from '../../../lib/response';
import { reachValidation } from '../../../lib/reach';

const app = new Hono<HonoEnv>();

app.get('/', requireScope('reach_prospects:read'), async (c) => {
  const page = await listProspectLists(c.get('tenantDb'), c.req.query());
  return list(c, page.data, cursorPagination(page.totalCount, page.hasMore, page.cursor));
});

app.get('/:id', requireScope('reach_prospects:read'), async (c) => {
  return success(c, await getProspectList(c.get('tenantDb'), c.req.param('id')));
});

app.post('/', requireScope('reach_prospects:write'), zValidator('json', createReachListSchema, reachValidation), async (c) => {
  return success(c, await createProspectList(c.get('tenantDb'), c.req.valid('json'), c.get('userId')), 201);
});

app.patch('/:id', requireScope('reach_prospects:write'), zValidator('json', updateReachListSchema, reachValidation), async (c) => {
  return success(c, await updateProspectList(c.get('tenantDb'), c.req.param('id'), c.req.valid('json')));
});

app.delete('/:id', requireScope('reach_prospects:write'), async (c) => {
  await deleteProspectList(c.get('tenantDb'), c.req.param('id'));
  return noContent(c);
});

app.post('/:id/members', requireScope('reach_prospects:write'), zValidator('json', reachListMembersSchema, reachValidation), async (c) => {
  return success(c, await addProspectListMembers(c.get('tenantDb'), c.req.param('id'), c.req.valid('json').prospectIds));
});

app.post('/:id/members/remove', requireScope('reach_prospects:write'), zValidator('json', reachListMembersSchema, reachValidation), async (c) => {
  return success(c, await removeProspectListMembers(c.get('tenantDb'), c.req.param('id'), c.req.valid('json').prospectIds));
});

export default app;
