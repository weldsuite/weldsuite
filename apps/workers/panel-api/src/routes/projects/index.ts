/**
 * Project routes: /api/panel/projects/*.
 *
 * A project is one website or app being tracked. Its public token is shown to
 * everyone who can read it (it can only send data), so `panel_projects:read`
 * is also what the install panel needs. Pausing, privacy settings and token
 * rotation are `:manage`, kept apart from renaming and domains (`:update`).
 *
 *   GET    /                 → list (not deleted)
 *   POST   /                 → new project (token issued, registered with the collector)
 *   GET    /:id              → one project
 *   PATCH  /:id              → name, kind, allowed domains
 *   PATCH  /:id/settings     → status and collector / privacy settings (partial)
 *   DELETE /:id              → soft delete; the collector refuses the token at once
 *   POST   /:id/rotate-token → new token; the old one stops working at once
 *   GET    /:id/install      → snippets and whether events are arriving
 *
 * Every change also updates the master registry row and the KV record the
 * collector reads (../../services/project-registry).
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createPanelProjectSchema,
  updatePanelProjectSchema,
  updatePanelProjectSettingsSchema,
} from '@weldsuite/app-api-client/schemas/weldpanel';
import type { PanelProject } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import type { ProjectRegistry } from '../../services/project-registry';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  loadInstallInfo,
  projectEventData,
  rotateProjectToken,
  toProjectDto,
  updateProject,
  updateProjectSettings,
} from '../../services/projects';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * What the collector's copy of a project needs: the master DB, the shared KV
 * namespace and the workspace's `workspaces.id`. Null without a workspace.
 */
function registryFor(c: Ctx): ProjectRegistry | null {
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return null;
  return { masterDb: getMasterDb(c.env), kv: c.env.WORKSPACE_CACHE, workspaceId };
}

function publishProjectEvent(c: Ctx, project: PanelProject, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({
    c,
    entityType: 'panel_project',
    entityId: project.id,
    action,
    data: projectEventData(project),
  });
}

app.get('/', requirePermission('panel_projects:read'), async (c) => {
  const projects = await listProjects(c.get('tenantDb'));
  return list(c, projects.map(toProjectDto), cursorPagination(projects.length, false, null));
});

app.post('/', requirePermission('panel_projects:create'), zValidator('json', createPanelProjectSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const registry = registryFor(c);
  if (!registry) return error.orgRequired(c);

  const project = await createProject(c.get('tenantDb'), registry, c.req.valid('json'), userId);
  publishProjectEvent(c, project, 'created');
  return success(c, toProjectDto(project), 201);
});

app.get('/:id', requirePermission('panel_projects:read'), async (c) => {
  const id = c.req.param('id');
  const project = await getProject(c.get('tenantDb'), id);
  if (!project) return error.notFound(c, 'Project', id);
  return success(c, toProjectDto(project));
});

app.patch('/:id', requirePermission('panel_projects:update'), zValidator('json', updatePanelProjectSchema), async (c) => {
  const id = c.req.param('id');
  const registry = registryFor(c);
  if (!registry) return error.orgRequired(c);

  const project = await updateProject(c.get('tenantDb'), registry, id, c.req.valid('json'));
  if (!project) return error.notFound(c, 'Project', id);
  publishProjectEvent(c, project, 'updated');
  return success(c, toProjectDto(project));
});

app.patch(
  '/:id/settings',
  requirePermission('panel_projects:manage'),
  zValidator('json', updatePanelProjectSettingsSchema),
  async (c) => {
    const id = c.req.param('id');
    const registry = registryFor(c);
    if (!registry) return error.orgRequired(c);

    const project = await updateProjectSettings(c.get('tenantDb'), registry, id, c.req.valid('json'));
    if (!project) return error.notFound(c, 'Project', id);
    publishProjectEvent(c, project, 'updated');
    return success(c, toProjectDto(project));
  },
);

app.delete('/:id', requirePermission('panel_projects:delete'), async (c) => {
  const id = c.req.param('id');
  const registry = registryFor(c);
  if (!registry) return error.orgRequired(c);

  const project = await deleteProject(c.get('tenantDb'), registry, id);
  if (!project) return error.notFound(c, 'Project', id);
  publishProjectEvent(c, project, 'deleted');
  return noContent(c);
});

app.post('/:id/rotate-token', requirePermission('panel_projects:manage'), async (c) => {
  const id = c.req.param('id');
  const registry = registryFor(c);
  if (!registry) return error.orgRequired(c);

  const result = await rotateProjectToken(c.get('tenantDb'), registry, id);
  if (result === 'not_found') return error.notFound(c, 'Project', id);
  if (result === 'conflict') return error.conflict(c, 'The token was just changed by someone else. Reload and try again.');
  publishProjectEvent(c, result.project, 'updated');
  return success(c, toProjectDto(result.project));
});

app.get('/:id/install', requirePermission('panel_projects:read'), async (c) => {
  const id = c.req.param('id');
  const project = await getProject(c.get('tenantDb'), id);
  if (!project) return error.notFound(c, 'Project', id);
  return success(c, await loadInstallInfo(c.env.WORKSPACE_CACHE, project, c.env.PANEL_COLLECTOR_URL));
});

export default app;
