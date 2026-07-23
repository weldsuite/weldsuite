/**
 * GitHub App Install Routes
 *
 * GET  /install-url  — Returns the GitHub App installation URL with a signed state JWT.
 * GET  /callback     — Handles the post-install redirect from GitHub, persists connection.
 *
 * Both routes require Clerk authentication. The callback additionally verifies
 * the state JWT to bind the installation to the correct workspace/user.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../../types';
import { success, error, list } from '../../lib/response';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  InstallUrlQuerySchema,
  RecoverInstallationInputSchema,
} from '@weldsuite/core-api-client/schemas/github';
import { signInstallStateJwt, mintAppJwt, fetchInstallationMeta } from '../../services/github/auth';
import {
  getConnectionByWorkspace,
  revokeConnection,
  upsertConnection,
} from '../../services/github/connections';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /install-url
// ---------------------------------------------------------------------------

app.get(
  '/install-url',
  requirePermission('integrations:github:manage'),
  zValidator('query', InstallUrlQuerySchema),
  async (c) => {
    const { projectId, returnTo } = c.req.valid('query');
    const workspaceId = c.get('workspaceId');
    const userId = c.get('userId');

    if (!workspaceId) {
      return error.orgRequired(c);
    }

    const appSlug = c.env.GITHUB_APP_SLUG;
    if (!appSlug) {
      return error.internal(c, 'GitHub App is not configured');
    }

    // Generate a nonce to tie this install flow to a single request
    const nonce = generateNonce();

    // We use CLERK_SECRET_KEY as the HMAC secret for the state JWT.
    // It is already required, always present, and never leaves the worker.
    const stateToken = await signInstallStateJwt(
      { workspaceId, userId, projectId: projectId ?? undefined, returnTo, nonce },
      c.env.CLERK_SECRET_KEY,
    );

    const installUrl =
      `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(stateToken)}`;

    return success(c, { url: installUrl });
  },
);

// NOTE: GET /callback is a PUBLIC route (GitHub redirect has no Clerk session).
// It is mounted separately in src/index.ts BEFORE the Clerk middleware so that
// this authenticated sub-router does not intercept it. See:
// apps/core-api/src/routes/public/github-callback.ts

// ---------------------------------------------------------------------------
// GET /connection  — Return current connection status
// ---------------------------------------------------------------------------

app.get(
  '/connection',
  requirePermission('integrations:github:manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.orgRequired(c);

    try {
      const db = c.get('tenantDb');
      const conn = await getConnectionByWorkspace(db, workspaceId);

      if (!conn) {
        return success(c, null);
      }

      return success(c, formatConnection(conn));
    } catch (err) {
      console.error('[GitHub] Failed to get connection:', err);
      return error.internal(c, 'Failed to get GitHub connection');
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /connection  — Disconnect (revoke) the integration
// ---------------------------------------------------------------------------

app.delete(
  '/connection',
  requirePermission('integrations:github:manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.orgRequired(c);

    try {
      const db = c.get('tenantDb');
      await revokeConnection(db, workspaceId);
      return new Response(null, { status: 204 });
    } catch (err) {
      console.error('[GitHub] Failed to disconnect:', err);
      return error.internal(c, 'Failed to disconnect GitHub');
    }
  },
);

// ---------------------------------------------------------------------------
// GET /installations/discoverable
// — Lists all installations visible to the GitHub App (up to 100; no
//   pagination — follow-up ticket if multi-page support is needed).
// ---------------------------------------------------------------------------

app.get(
  '/installations/discoverable',
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
      const appJwt = await mintAppJwt(appId, privateKey);

      const resp = await fetch('https://api.github.com/app/installations?per_page=100', {
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'WeldSuite-Core-API',
        },
      });

      if (!resp.ok) {
        const body = await resp.text();
        console.error('[GitHub] Failed to list installations:', resp.status, body);
        return error.internal(c, 'Failed to fetch GitHub installations');
      }

      const raw = (await resp.json()) as Array<{
        id: number;
        app_slug: string;
        account: { login: string; type: string };
        repository_selection: string;
      }>;

      const installations = raw.map((item) => ({
        id: item.id,
        accountLogin: item.account.login,
        accountType: (item.account.type === 'Organization' ? 'Organization' : 'User') as
          | 'Organization'
          | 'User',
        appSlug: item.app_slug,
        repositorySelection: item.repository_selection,
      }));

      return list(c, installations, {
        totalCount: installations.length,
        hasMore: false,
        cursor: null,
      });
    } catch (err) {
      console.error('[GitHub] Failed to list installations:', err);
      return error.internal(c, 'Failed to fetch GitHub installations');
    }
  },
);

// ---------------------------------------------------------------------------
// POST /recover
// — Recover an existing GitHub installation into this workspace without
//   going through the full OAuth redirect flow.
// ---------------------------------------------------------------------------

app.post(
  '/recover',
  requirePermission('integrations:github:manage'),
  zValidator('json', RecoverInstallationInputSchema),
  async (c) => {
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.orgRequired(c);

    const userId = c.get('userId');
    const { installationId } = c.req.valid('json');

    const appId = c.env.GITHUB_APP_ID;
    const privateKey = c.env.GITHUB_APP_PRIVATE_KEY;
    const encryptionKey = { v1: c.env.DATABASE_ENCRYPTION_KEY, v2: c.env.DATABASE_ENCRYPTION_KEY_V2 };

    if (!appId || !privateKey) {
      return error.internal(c, 'GitHub App is not configured');
    }
    if (!encryptionKey.v1 && !encryptionKey.v2) {
      return error.internal(c, 'GitHub App is not configured');
    }

    try {
      const meta = await fetchInstallationMeta(appId, privateKey, installationId);

      const db = c.get('tenantDb');
      const { connection } = await upsertConnection(
        db,
        workspaceId,
        {
          installationId,
          appSlug: meta.appSlug,
          ownerType: meta.accountType === 'Organization' ? 'org' : 'user',
          ownerLogin: meta.accountLogin,
          status: 'active',
          createdBy: userId,
        },
        encryptionKey,
      );

      return success(c, formatConnection(connection));
    } catch (err) {
      console.error('[GitHub] Failed to recover installation:', err);
      return error.internal(c, 'Failed to recover GitHub installation');
    }
  },
);

// ============================================================================
// Helpers
// ============================================================================

function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Serialise a githubConnections row for API responses.
 * Strips the encrypted webhookSecret and ISO-stringifies all Date fields.
 */
function formatConnection(conn: {
  webhookSecret?: string | null;
  installedAt?: Date | null;
  revokedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
  [key: string]: unknown;
}) {
  const { webhookSecret: _secret, ...safeConn } = conn;
  return {
    ...safeConn,
    installedAt: safeConn.installedAt instanceof Date ? safeConn.installedAt.toISOString() : (safeConn.installedAt ?? null),
    revokedAt: safeConn.revokedAt instanceof Date ? safeConn.revokedAt.toISOString() : (safeConn.revokedAt ?? null),
    createdAt: safeConn.createdAt instanceof Date ? safeConn.createdAt.toISOString() : safeConn.createdAt,
    updatedAt: safeConn.updatedAt instanceof Date ? safeConn.updatedAt.toISOString() : safeConn.updatedAt,
    deletedAt: safeConn.deletedAt instanceof Date ? safeConn.deletedAt.toISOString() : (safeConn.deletedAt ?? null),
  };
}

export { app as githubInstallRoutes };
