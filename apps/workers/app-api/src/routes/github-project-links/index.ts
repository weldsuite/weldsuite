/**
 * GitHub Project (v2) link routes — /api/github-project-links/*
 *
 * One WeldFlow project ↔ one GitHub Project (v2). Many WeldFlow projects may
 * link to Projects drawing issues from the same repository.
 *
 *   GET    /github-project-links?projectId=   — list links (optionally by project)
 *   GET    /github-project-links/:id          — get one link
 *   POST   /github-project-links              — link a Project to a WeldFlow project
 *   PATCH  /github-project-links/:id          — update sync settings / status mapping
 *   DELETE /github-project-links/:id          — unlink
 *   POST   /github-project-links/:id/sync     — trigger a sync for this link
 *
 * All routes require Clerk auth and the github:manage permission.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../../types';
import { success, error, list, cursorPagination, noContent } from '../../lib/response';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  LinkProjectInputSchema,
  UpdateProjectLinkInputSchema,
  ListLinkedProjectsQuerySchema,
} from '@weldsuite/core-api-client/schemas/github';
import { getConnectionByWorkspace } from '../../services/github/connections';
import {
  listLinkedProjects,
  getLinkedProject,
  linkProject,
  updateProjectLink,
  unlinkProject,
  serializeProjectLink,
} from '../../services/github/projects';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET / — list project links
// ---------------------------------------------------------------------------

app.get(
  '/',
  requirePermission('integrations:github:manage'),
  zValidator('query', ListLinkedProjectsQuerySchema),
  async (c) => {
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.orgRequired(c);

    const { projectId, cursor, limit } = c.req.valid('query');

    try {
      const db = c.get('tenantDb');
      const result = await listLinkedProjects(db, workspaceId, {
        projectId: projectId ?? undefined,
        cursor,
        limit,
      });

      return list(
        c,
        result.data.map(serializeProjectLink),
        cursorPagination(result.totalCount, result.hasMore, result.cursor),
      );
    } catch (err) {
      console.error('[GitHub] Failed to list linked projects:', err);
      return error.internal(c, 'Failed to list linked projects');
    }
  },
);

// ---------------------------------------------------------------------------
// GET /:id — get one project link
// ---------------------------------------------------------------------------

app.get('/:id', requirePermission('integrations:github:manage'), async (c) => {
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);

  const id = c.req.param('id');

  try {
    const db = c.get('tenantDb');
    const row = await getLinkedProject(db, workspaceId, id);
    if (!row) return error.notFound(c, 'GitHub project link', id);
    return success(c, serializeProjectLink(row));
  } catch (err) {
    console.error('[GitHub] Failed to fetch project link:', err);
    return error.internal(c, 'Failed to fetch project link');
  }
});

// ---------------------------------------------------------------------------
// POST / — link a Project
// ---------------------------------------------------------------------------

app.post(
  '/',
  requirePermission('integrations:github:manage'),
  zValidator('json', LinkProjectInputSchema),
  async (c) => {
    const workspaceId = c.get('workspaceId');
    const userId = c.get('userId');
    if (!workspaceId) return error.orgRequired(c);

    const input = c.req.valid('json');

    try {
      const db = c.get('tenantDb');
      const conn = await getConnectionByWorkspace(db, workspaceId);

      if (!conn || conn.status !== 'active') {
        return error.badRequest(c, 'No active GitHub connection. Install the GitHub App first.');
      }

      const row = await linkProject(db, workspaceId, conn.id, input, userId);
      return success(c, serializeProjectLink(row), 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('unique') || message.includes('duplicate')) {
        return error.conflict(
          c,
          'This WeldFlow project is already linked to a GitHub Project, or this Project is already linked.',
        );
      }
      console.error('[GitHub] Failed to link project:', err);
      return error.internal(c, 'Failed to link project');
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /:id — update a project link
// ---------------------------------------------------------------------------

app.patch(
  '/:id',
  requirePermission('integrations:github:manage'),
  zValidator('json', UpdateProjectLinkInputSchema),
  async (c) => {
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.orgRequired(c);

    const id = c.req.param('id');
    const input = c.req.valid('json');

    try {
      const db = c.get('tenantDb');
      const updated = await updateProjectLink(db, workspaceId, id, input);
      if (!updated) return error.notFound(c, 'GitHub project link', id);
      return success(c, serializeProjectLink(updated));
    } catch (err) {
      console.error('[GitHub] Failed to update project link:', err);
      return error.internal(c, 'Failed to update project link');
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /:id — unlink a project
// ---------------------------------------------------------------------------

app.delete('/:id', requirePermission('integrations:github:manage'), async (c) => {
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);

  const id = c.req.param('id');

  try {
    const db = c.get('tenantDb');
    const deleted = await unlinkProject(db, workspaceId, id);
    if (!deleted) return error.notFound(c, 'GitHub project link', id);
    return noContent(c);
  } catch (err) {
    console.error('[GitHub] Failed to unlink project:', err);
    return error.internal(c, 'Failed to unlink project');
  }
});

// ---------------------------------------------------------------------------
// POST /:id/sync — trigger a sync for this project link
//
// Dispatches to the GithubProjectSyncWorkflow (class hosted in core-api) via the
// GITHUB_PROJECT_SYNC binding. The same workflow backs the automatic sync; the
// manual trigger just kicks it immediately.
// ---------------------------------------------------------------------------

app.post('/:id/sync', requirePermission('integrations:github:manage'), async (c) => {
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);

  const id = c.req.param('id');

  try {
    const db = c.get('tenantDb');

    const conn = await getConnectionByWorkspace(db, workspaceId);
    if (!conn || conn.status !== 'active') {
      return error.badRequest(c, 'No active GitHub connection.');
    }

    const link = await getLinkedProject(db, workspaceId, id);
    if (!link) return error.notFound(c, 'GitHub project link', id);

    if (!c.env.GITHUB_PROJECT_SYNC) {
      return error.internal(c, 'GitHub project-sync workflow binding not configured');
    }

    // Serialize: one sync instance per link per minute. A duplicate create
    // (rapid clicks / overlapping runs) throws "instance exists" and is treated
    // as "already running" — preventing concurrent reconciles that could race to
    // create duplicate issues.
    const bucket = Math.floor(Date.now() / 60000);
    const runId = `github-project-sync-${id}-${bucket}`;
    try {
      await c.env.GITHUB_PROJECT_SYNC.create({ id: runId, params: { workspaceId, projectLinkId: id } });
      console.log(`[GitHub] Project sync started for link ${id}, runId: ${runId}`);
    } catch {
      console.log(`[GitHub] Project sync already running for link ${id} (${runId}) — reusing`);
    }

    return success(c, { runId });
  } catch (err) {
    console.error('[GitHub] Failed to trigger project sync:', err);
    return error.internal(c, 'Failed to trigger synchronization');
  }
});

export const githubProjectLinksRoutes = app;
