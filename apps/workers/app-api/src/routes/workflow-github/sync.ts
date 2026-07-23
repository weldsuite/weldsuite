/**
 * GitHub Sync Routes
 *
 * POST /repos/:linkId/sync — Trigger a full re-sync of a linked repository.
 *
 * Dispatches to GithubFullSyncWorkflow via the GITHUB_FULL_SYNC Cloudflare Workflow binding.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { success, error } from '../../lib/response';
import { requirePermission } from '@weldsuite/permissions/server';
import { getConnectionByWorkspace } from '../../services/github/connections';
import { getLinkedRepo } from '../../services/github/repos';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// POST /repos/:linkId/sync
// ---------------------------------------------------------------------------

app.post(
  '/repos/:linkId/sync',
  requirePermission('integrations:github:manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.orgRequired(c);

    const linkId = c.req.param('linkId');

    try {
      const db = c.get('tenantDb');

      // Verify connection is active
      const conn = await getConnectionByWorkspace(db, workspaceId);
      if (!conn || conn.status !== 'active') {
        return error.badRequest(c, 'No active GitHub connection.');
      }

      // Verify the repo link exists and belongs to this workspace
      const repoLink = await getLinkedRepo(db, workspaceId, linkId);
      if (!repoLink) {
        return error.notFound(c, 'Repository link', linkId);
      }

      if (!c.env.GITHUB_FULL_SYNC) {
        return error.internal(c, 'GitHub full-sync workflow binding not configured');
      }
      const instance = await c.env.GITHUB_FULL_SYNC.create({
        id: `github-full-sync-${linkId}-${Date.now()}`,
        params: { workspaceId, repoLinkId: linkId },
      });

      console.log(`[GitHub] Full sync workflow started for repo link ${linkId}, runId: ${instance.id}`);

      return success(c, { runId: instance.id });
    } catch (err) {
      console.error('[GitHub] Failed to trigger sync:', err);
      return error.internal(c, 'Failed to trigger synchronization');
    }
  },
);

export { app as githubSyncRoutes };
