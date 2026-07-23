/**
 * GitHub App Install Callback — PUBLIC route
 *
 * GET /api/weldconnect/github/callback
 *
 * Mounted BEFORE Clerk auth (GitHub's server-to-server redirect has no Clerk
 * session). Authenticated via the state JWT signed during `/install-url`
 * (HS256 with CLERK_SECRET_KEY); the workspace is resolved from the JWT claims.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { verifyInstallStateJwt, fetchInstallationMeta } from '../services/github/auth';
import { upsertConnection, revokeConnection } from '../services/github/connections';
import { getTenantDbForWorkspace } from '../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// The browser must land back on the platform app, not on app-api. Error
// redirects use this absolute base; success uses the absolute `returnTo`.
const APP_BASE = 'https://app.weldsuite.org';
const settingsPath = (qs: string) => `${APP_BASE}/settings/integrations/github${qs}`;

app.get('/callback', async (c) => {
  const query = c.req.query();
  const installationId = query.installation_id ? Number(query.installation_id) : null;
  const setupAction = query.setup_action;
  const stateToken = query.state;

  if (!installationId || !stateToken) {
    return c.redirect(settingsPath('?error=missing_params'));
  }

  const claims = await verifyInstallStateJwt(stateToken, c.env.CLERK_SECRET_KEY);
  if (!claims) {
    return c.redirect(settingsPath('?error=invalid_state'));
  }

  const { workspaceId, returnTo } = claims;
  const successRedirect = returnTo || settingsPath('?installed=1');

  const encryptionKey = { v1: c.env.DATABASE_ENCRYPTION_KEY, v2: c.env.DATABASE_ENCRYPTION_KEY_V2 };
  if (!encryptionKey.v1 && !encryptionKey.v2) {
    console.error('[GitHub] DATABASE_ENCRYPTION_KEY is not configured');
    return c.redirect(settingsPath('?error=configuration_error'));
  }

  const appId = c.env.GITHUB_APP_ID;
  const privateKey = c.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    console.error('[GitHub] GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is not configured');
    return c.redirect(settingsPath('?error=configuration_error'));
  }

  try {
    const db = await getTenantDbForWorkspace(c.env, workspaceId);

    if (setupAction === 'delete') {
      await revokeConnection(db, workspaceId);
      return c.redirect(settingsPath('?disconnected=1'));
    }

    const meta = await fetchInstallationMeta(appId, privateKey, installationId);

    await upsertConnection(
      db,
      workspaceId,
      {
        installationId,
        appSlug: meta.appSlug,
        ownerType: meta.accountType === 'Organization' ? 'org' : 'user',
        ownerLogin: meta.accountLogin,
        status: 'active',
        createdBy: claims.userId,
      },
      encryptionKey,
    );

    console.log(`[GitHub] Installation ${installationId} persisted for workspace ${workspaceId}`);
    return c.redirect(successRedirect);
  } catch (err) {
    const e = err as { message?: string; cause?: unknown };
    console.error(
      '[GitHub] Callback error:',
      e?.message,
      '| cause:',
      e?.cause instanceof Error ? e.cause.message : String(e?.cause),
    );
    return c.redirect(settingsPath('?error=internal_error'));
  }
});

export { app as githubCallbackRoutes };
