/**
 * Groups: /api/panel/groups/*. Group profiles (a company, an account) live in
 * the project's Durable Object (ADR PANEL-004); their activity comes from
 * Basin, read through the events that carry `$group_<type>`.
 *
 *   GET    /             → ?projectId&type: one type's groups (cursor, `search`)   (`panel_people:read`)
 *   GET    /:type/:key   → profile, recent events, members, the WeldCRM company (`?projectId&days`)
 *   DELETE /:type/:key   → deletes the profile (`panel_people:delete`, `?projectId`)
 *
 * The WeldCRM company is looked up only for callers who can read companies
 * (`companies:read`, own companies unless `companies:scope:all`), like the CRM
 * itself would show them. Group profiles are tracked visitor-side data, like
 * people: they never go on the entity bus (EVT-005), so deleting one publishes
 * no event; the object writes the `deleted` row to `groups_v1`.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  panelGroupDeleteQuerySchema,
  panelGroupKeySchema,
  panelGroupListQuerySchema,
  panelGroupProfileQuerySchema,
} from '@weldsuite/app-api-client/schemas/weldpanel-groups';
import { GROUP_TYPE } from '@weldsuite/panel-domain/wire';
import type { Env, Variables } from '../../types';
import { queryFailure } from '../../http';
import { deleteGroup, listGroups, loadGroupProfile, type CrmLookup } from '../../services/groups';
import { getProject } from '../../services/projects';
import { queryRunDeps } from '../../services/query-run';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** `:type` matches the collector's `GROUP_TYPE`; `:key` arrives URL-decoded. */
const groupParams = z.object({ type: z.string().regex(GROUP_TYPE, 'Not a valid group type'), key: panelGroupKeySchema });

/** How the caller may see WeldCRM companies: null without `companies:read`. */
async function crmLookupFor(c: Ctx): Promise<CrmLookup | null> {
  if (!(await hasContextPermission(c, 'companies:read'))) return null;
  if (await hasContextPermission(c, 'companies:scope:all')) return {};
  const userId = c.get('userId');
  return userId ? { ownerScope: userId } : null;
}

app.get('/', requirePermission('panel_people:read'), zValidator('query', panelGroupListQuerySchema), async (c) => {
  const { projectId, ...query } = c.req.valid('query');
  const db = c.get('tenantDb');
  if (!(await getProject(db, projectId))) return error.notFound(c, 'Project', projectId);

  try {
    const page = await listGroups(c.env, projectId, query);
    return list(c, page.groups, cursorPagination(page.totalCount, page.hasMore, page.cursor));
  } catch (err) {
    return queryFailure(c, err);
  }
});

app.get(
  '/:type/:key',
  requirePermission('panel_people:read'),
  zValidator('param', groupParams),
  zValidator('query', panelGroupProfileQuerySchema),
  async (c) => {
    const { type, key } = c.req.valid('param');
    const { projectId, days } = c.req.valid('query');
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.orgRequired(c);
    const tenantDb = c.get('tenantDb');
    if (!(await getProject(tenantDb, projectId))) return error.notFound(c, 'Project', projectId);

    try {
      const crm = await crmLookupFor(c);
      const profile = await loadGroupProfile(queryRunDeps(c.env, tenantDb, workspaceId), projectId, type, key, { days, crm });
      if (!profile) return error.notFound(c, 'Group', key);
      return success(c, profile);
    } catch (err) {
      return queryFailure(c, err);
    }
  },
);

app.delete(
  '/:type/:key',
  requirePermission('panel_people:delete'),
  zValidator('param', groupParams),
  zValidator('query', panelGroupDeleteQuerySchema),
  async (c) => {
    const { type, key } = c.req.valid('param');
    const { projectId } = c.req.valid('query');
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.orgRequired(c);
    if (!(await getProject(c.get('tenantDb'), projectId))) return error.notFound(c, 'Project', projectId);

    try {
      if (!(await deleteGroup(c.env, workspaceId, projectId, type, key))) return error.notFound(c, 'Group', key);
      return noContent(c);
    } catch (err) {
      return queryFailure(c, err);
    }
  },
);

export default app;
