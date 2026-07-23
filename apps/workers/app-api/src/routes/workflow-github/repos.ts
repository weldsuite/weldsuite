/**
 * GitHub Repository Routes
 *
 * GET    /repos/available           — List repos accessible to the installation
 * GET    /repos/linked?projectId=   — List repos linked to this workspace/project
 * POST   /repos/link                — Link a repo to a project
 * PATCH  /repos/:linkId             — Update sync settings for a linked repo
 * DELETE /repos/:linkId             — Unlink a repo
 *
 * All routes require Clerk auth and the github:manage permission.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../../types';
import { success, error, list, cursorPagination, noContent } from '../../lib/response';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  LinkRepoInputSchema,
  UpdateRepoLinkInputSchema,
  ListLinkedReposQuerySchema,
} from '@weldsuite/core-api-client/schemas/github';
import { getConnectionByWorkspace } from '../../services/github/connections';
import { getInstallationToken } from '../../services/github/auth';
import {
  listAvailableRepos,
  listLinkedRepos,
  getLinkedRepo,
  linkRepo,
  updateRepoLink,
  unlinkRepo,
} from '../../services/github/repos';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /repos/available
// ---------------------------------------------------------------------------

app.get(
  '/repos/available',
  requirePermission('integrations:github:manage'),
  async (c) => {
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
      const repos = await listAvailableRepos(token);

      return list(c, repos, cursorPagination(repos.length, false, null));
    } catch (err) {
      console.error('[GitHub] Failed to list available repos:', err);
      return error.internal(c, 'Failed to list available repositories');
    }
  },
);

// ---------------------------------------------------------------------------
// GET /repos/linked
// ---------------------------------------------------------------------------

app.get(
  '/repos/linked',
  requirePermission('integrations:github:manage'),
  zValidator('query', ListLinkedReposQuerySchema),
  async (c) => {
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.orgRequired(c);

    const { projectId, cursor, limit } = c.req.valid('query');

    try {
      const db = c.get('tenantDb');
      const result = await listLinkedRepos(db, workspaceId, {
        projectId: projectId ?? undefined,
        cursor,
        limit,
      });

      return list(
        c,
        result.data.map(serializeRepoLink),
        cursorPagination(result.totalCount, result.hasMore, result.cursor),
      );
    } catch (err) {
      console.error('[GitHub] Failed to list linked repos:', err);
      return error.internal(c, 'Failed to list linked repositories');
    }
  },
);

// ---------------------------------------------------------------------------
// POST /repos/link
// ---------------------------------------------------------------------------

app.post(
  '/repos/link',
  requirePermission('integrations:github:manage'),
  zValidator('json', LinkRepoInputSchema),
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

      const row = await linkRepo(db, workspaceId, conn.id, input, userId);
      return success(c, serializeRepoLink(row), 201);
    } catch (err) {
      // Catch unique constraint violation (already linked)
      const message = err instanceof Error ? err.message : '';
      if (message.includes('unique') || message.includes('duplicate')) {
        return error.conflict(c, 'This repository is already linked.');
      }
      console.error('[GitHub] Failed to link repo:', err);
      return error.internal(c, 'Failed to link repository');
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /repos/:linkId
// ---------------------------------------------------------------------------

app.patch(
  '/repos/:linkId',
  requirePermission('integrations:github:manage'),
  zValidator('json', UpdateRepoLinkInputSchema),
  async (c) => {
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.orgRequired(c);

    const linkId = c.req.param('linkId');
    const input = c.req.valid('json');

    try {
      const db = c.get('tenantDb');
      const updated = await updateRepoLink(db, workspaceId, linkId, input);

      if (!updated) {
        return error.notFound(c, 'Repository link', linkId);
      }

      return success(c, serializeRepoLink(updated));
    } catch (err) {
      console.error('[GitHub] Failed to update repo link:', err);
      return error.internal(c, 'Failed to update repository link');
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /repos/:linkId
// ---------------------------------------------------------------------------

app.delete(
  '/repos/:linkId',
  requirePermission('integrations:github:manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.orgRequired(c);

    const linkId = c.req.param('linkId');

    try {
      const db = c.get('tenantDb');
      const deleted = await unlinkRepo(db, workspaceId, linkId);

      if (!deleted) {
        return error.notFound(c, 'Repository link', linkId);
      }

      return noContent(c);
    } catch (err) {
      console.error('[GitHub] Failed to unlink repo:', err);
      return error.internal(c, 'Failed to unlink repository');
    }
  },
);

// ============================================================================
// Helpers
// ============================================================================

function serializeRepoLink(row: {
  id: string;
  workspaceId: string;
  connectionId: string;
  projectId: string | null;
  repoId: number;
  repoFullName: string;
  defaultBranch: string | null;
  syncIssues: boolean;
  syncDirection: string;
  lastSyncedAt: Date | null;
  syncCursor: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    connectionId: row.connectionId,
    projectId: row.projectId,
    repoId: row.repoId,
    repoFullName: row.repoFullName,
    defaultBranch: row.defaultBranch,
    syncIssues: row.syncIssues,
    syncDirection: row.syncDirection,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    syncCursor: row.syncCursor,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export { app as githubReposRoutes };
