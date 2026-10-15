/**
 * Prospects: /v1/reach/prospects
 *
 * Scopes: reach_prospects:read (list, get) and reach_prospects:write (create,
 * update, delete, import).
 *
 * The same domain functions as reach-api's `/api/reach/prospects`
 * (`@weldsuite/reach-domain/prospects`): every prospect gets a `validation`
 * verdict, an import stores every parseable row and reports the ones it cannot
 * use, and `reach_prospect:created` is published for the first
 * MAX_IMPORT_EVENTS new prospects of an import. Only the JSON import is public:
 * the CRM-list and WeldData imports read other modules and stay in the app.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  importReachProspectsSchema,
  reachProspectInputSchema,
  updateReachProspectSchema,
} from '@weldsuite/app-api-client/schemas/reach';
import { createProspect, deleteProspect, getProspect, importProspectRows, listProspects, updateProspect } from '@weldsuite/reach-domain/prospects';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { cursorPagination, list, noContent, success } from '../../../lib/response';
import { reachDeps, reachValidation } from '../../../lib/reach';

const app = new Hono<HonoEnv>();

app.get('/', requireScope('reach_prospects:read'), async (c) => {
  const page = await listProspects(c.get('tenantDb'), c.req.query());
  return list(c, page.data, cursorPagination(page.totalCount, page.hasMore, page.cursor));
});

app.get('/:id', requireScope('reach_prospects:read'), async (c) => {
  return success(c, await getProspect(c.get('tenantDb'), c.req.param('id')));
});

app.post(
  '/',
  requireScope('reach_prospects:write'),
  zValidator('json', reachProspectInputSchema.extend({ listId: z.string().min(1).max(30).optional() }), reachValidation),
  async (c) => {
    return success(c, await createProspect(reachDeps(c), c.req.valid('json')), 201);
  },
);

app.post('/import', requireScope('reach_prospects:write'), zValidator('json', importReachProspectsSchema, reachValidation), async (c) => {
  return success(c, await importProspectRows(reachDeps(c), c.req.valid('json')));
});

app.patch('/:id', requireScope('reach_prospects:write'), zValidator('json', updateReachProspectSchema, reachValidation), async (c) => {
  return success(c, await updateProspect(reachDeps(c), c.req.param('id'), c.req.valid('json')));
});

app.delete('/:id', requireScope('reach_prospects:write'), async (c) => {
  await deleteProspect(reachDeps(c), c.req.param('id'));
  return noContent(c);
});

export default app;
