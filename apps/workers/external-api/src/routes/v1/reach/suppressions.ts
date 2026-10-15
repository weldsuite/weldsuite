/**
 * The suppression list: /v1/reach/suppressions
 *
 * Scopes: reach_settings:read (list) and reach_settings:write (add, delete),
 * the permission object reach-api uses for the list. Adding entries stops the
 * matching prospects' queued and active enrollments; removing one lets a
 * prospect be enrolled again. No entity events for the entries: the list is a
 * compliance record (a campaign that runs out of prospects because of one still
 * publishes `reach_campaign:completed`). The same domain functions as
 * reach-api's `/api/reach/suppressions`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { addReachSuppressionsSchema } from '@weldsuite/app-api-client/schemas/reach';
import { addManualSuppressions, listSuppressions, removeSuppression } from '@weldsuite/reach-domain/suppressions';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { cursorPagination, list, noContent, success } from '../../../lib/response';
import { reachDeps, reachValidation } from '../../../lib/reach';

const app = new Hono<HonoEnv>();

app.get('/', requireScope('reach_settings:read'), async (c) => {
  const page = await listSuppressions(c.get('tenantDb'), c.req.query());
  return list(c, page.data, cursorPagination(page.totalCount, page.hasMore, page.cursor));
});

app.post('/', requireScope('reach_settings:write'), zValidator('json', addReachSuppressionsSchema, reachValidation), async (c) => {
  return success(c, await addManualSuppressions(reachDeps(c), c.req.valid('json').values), 201);
});

app.delete('/:id', requireScope('reach_settings:write'), async (c) => {
  await removeSuppression(c.get('tenantDb'), c.req.param('id'));
  return noContent(c);
});

export default app;
