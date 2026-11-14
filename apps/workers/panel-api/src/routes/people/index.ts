/**
 * People: /api/panel/people/*. Profiles live in the project's Durable Object
 * (ADR PANEL-004); activity and recordings come from Basin.
 *
 *   GET    /                 → list and search (cursor); `?cohortId` narrows to a cohort   (`panel_people:read`)
 *   GET    /by-email         → profiles with that email in any project, for the WeldCRM card
 *   GET    /:distinctId      → profile, recent events, recordings (`?projectId`)
 *   DELETE /:distinctId      → GDPR erasure (`panel_people:delete`, `?projectId`)
 *
 * `by-email` also opens for `people:read`: the WeldCRM person card asks it for
 * someone the caller can already see in the CRM, so a CRM user does not need a
 * WeldPanel grant to see that person's website activity. Recordings stay behind
 * `panel_recordings:read` there. Visitor data never goes on the entity bus
 * (EVT-005), so erasure publishes no event; the object keeps the trail.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { queryFailure } from '../../http';
import { ErasureIncompleteError, erasePerson } from '../../services/erasure';
import { listPeople, loadProfile, peopleByEmail } from '../../services/people';
import { getProject } from '../../services/projects';
import { queryRunDeps } from '../../services/query-run';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const projectId = z.string().min(1).max(30);
const distinctId = z.string().min(1).max(255);

const listQuery = z.object({
  projectId,
  search: z.string().trim().max(200).optional(),
  cursor: z.string().max(500).nullish(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cohortId: z.string().min(1).max(30).optional(),
});
const byEmailQuery = z.object({ email: z.string().trim().min(3).max(320) });
const projectQuery = z.object({ projectId });

app.get('/', requirePermission('panel_people:read'), zValidator('query', listQuery), async (c) => {
  const query = c.req.valid('query');
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const tenantDb = c.get('tenantDb');
  if (!(await getProject(tenantDb, query.projectId))) return error.notFound(c, 'Project', query.projectId);

  try {
    const page = await listPeople(queryRunDeps(c.env, tenantDb, workspaceId), query.projectId, query);
    return list(c, page.people, cursorPagination(page.totalCount, page.hasMore, page.cursor));
  } catch (err) {
    return queryFailure(c, err);
  }
});

// Registered before '/:distinctId' so "by-email" is not read as an id.
app.get('/by-email', requirePermission('panel_people:read', 'people:read'), zValidator('query', byEmailQuery), async (c) => {
  const { email } = c.req.valid('query');
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const tenantDb = c.get('tenantDb');

  try {
    const includeSessions = await hasContextPermission(c, 'panel_recordings:read');
    return success(c, await peopleByEmail(queryRunDeps(c.env, tenantDb, workspaceId), tenantDb, email, { includeSessions }));
  } catch (err) {
    return queryFailure(c, err);
  }
});

app.get('/:distinctId', requirePermission('panel_people:read'), zValidator('query', projectQuery), async (c) => {
  const { projectId: project } = c.req.valid('query');
  const id = distinct(c.req.param('distinctId'));
  if (id === null) return error.badRequest(c, 'Invalid person id');
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const tenantDb = c.get('tenantDb');
  if (!(await getProject(tenantDb, project))) return error.notFound(c, 'Project', project);

  try {
    const includeSessions = await hasContextPermission(c, 'panel_recordings:read');
    const profile = await loadProfile(queryRunDeps(c.env, tenantDb, workspaceId), project, id, { includeSessions });
    if (!profile) return error.notFound(c, 'Person', id);
    return success(c, profile);
  } catch (err) {
    return queryFailure(c, err);
  }
});

app.delete('/:distinctId', requirePermission('panel_people:delete'), zValidator('query', projectQuery), async (c) => {
  const { projectId: project } = c.req.valid('query');
  const id = distinct(c.req.param('distinctId'));
  if (id === null) return error.badRequest(c, 'Invalid person id');
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const tenantDb = c.get('tenantDb');
  if (!(await getProject(tenantDb, project))) return error.notFound(c, 'Project', project);

  try {
    return success(c, await erasePerson(queryRunDeps(c.env, tenantDb, workspaceId), project, id));
  } catch (err) {
    if (err instanceof ErasureIncompleteError) {
      return c.json({ error: { code: 'ERASURE_INCOMPLETE', message: err.message, details: err.result } }, 502);
    }
    return queryFailure(c, err);
  }
});

/** The path parameter as a person id, or null when it is not one. */
function distinct(raw: string): string | null {
  const parsed = distinctId.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export default app;
