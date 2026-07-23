/**
 * GitHub Projects (v2) read routes — mounted under /api/workflow-github.
 *
 * GET /projects/available              — Projects (v2) visible to the installation
 * GET /projects/status-fields?nodeId=  — a Project's "Status" single-select options
 *
 * These are GraphQL reads used by the link picker + status→stage mapping UI.
 * All routes require Clerk auth and the github:manage permission.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../../types';
import { success, error, list, cursorPagination } from '../../lib/response';
import { requirePermission } from '@weldsuite/permissions/server';
import { ProjectStatusFieldsQuerySchema } from '@weldsuite/core-api-client/schemas/github';
import { getConnectionByWorkspace } from '../../services/github/connections';
import { getInstallationToken } from '../../services/github/auth';
import { listAvailableProjectsV2, getProjectStatusFields } from '../../services/github/projects';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /projects/available
// ---------------------------------------------------------------------------

app.get('/projects/available', requirePermission('integrations:github:manage'), async (c) => {
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);

  const appId = c.env.GITHUB_APP_ID;
  const privateKey = c.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    return error.internal(c, 'GitHub App is not configured');
  }

  try {
    const db = c.get('tenantDb');
    const conn = await getConnectionByWorkspace(db, workspaceId);
    if (!conn || conn.status !== 'active') {
      return error.notFound(c, 'GitHub connection');
    }

    const token = await getInstallationToken(appId, privateKey, conn.installationId);
    const projects = await listAvailableProjectsV2(token, conn.ownerLogin, conn.ownerType);

    console.log(
      `[GitHub] available projects for ${conn.ownerType}/${conn.ownerLogin}: count=${projects.length} numbers=${JSON.stringify(projects.map((p) => p.number))}`,
    );
    return list(c, projects, cursorPagination(projects.length, false, null));
  } catch (err) {
    console.error('[GitHub] Failed to list available projects:', err);
    return error.internal(c, 'Failed to list available projects');
  }
});

// ---------------------------------------------------------------------------
// GET /projects/status-fields?nodeId=
// ---------------------------------------------------------------------------

app.get(
  '/projects/status-fields',
  requirePermission('integrations:github:manage'),
  zValidator('query', ProjectStatusFieldsQuerySchema),
  async (c) => {
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.orgRequired(c);

    const { nodeId } = c.req.valid('query');

    const appId = c.env.GITHUB_APP_ID;
    const privateKey = c.env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !privateKey) {
      return error.internal(c, 'GitHub App is not configured');
    }

    try {
      const db = c.get('tenantDb');
      const conn = await getConnectionByWorkspace(db, workspaceId);
      if (!conn || conn.status !== 'active') {
        return error.notFound(c, 'GitHub connection');
      }

      const token = await getInstallationToken(appId, privateKey, conn.installationId);
      const fieldInfo = await getProjectStatusFields(token, nodeId);

      return success(c, fieldInfo);
    } catch (err) {
      console.error('[GitHub] Failed to read project status fields:', err);
      return error.internal(c, 'Failed to read project status fields');
    }
  },
);

export { app as githubProjectsRoutes };
