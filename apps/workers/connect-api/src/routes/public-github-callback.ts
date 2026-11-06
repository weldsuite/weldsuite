/**
 * GitHub App Install Callback — PUBLIC route
 *
 * GET /api/weldconnect/github/callback
 *
 * Mounted BEFORE Clerk auth (GitHub's server-to-server redirect has no Clerk
 * session). Authenticated via the state JWT signed during `/install-url`
 * (HS256 with CLERK_SECRET_KEY); the workspace is resolved from the JWT claims.
 * The state is single use (its nonce is taken from WORKSPACE_CACHE:
 * `error=state_expired` on a replay), and `installation_id` is GitHub's word
 * only once a user token proves the installer can reach it: the one GitHub's
 * `code` is exchanged for, else the member's linked GitHub account
 * (`error=installation_unverified`). An installation another workspace holds
 * is refused (`error=installation_taken`). `setup_action=delete` revokes the
 * workspace's own connection and drops the index row only when it names it.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { verifyInstallStateJwt, fetchInstallationMeta } from '../services/github/auth';
import { recordInstallation } from '../services/github/connections';
import { getMasterDb, getTenantDbForWorkspace, getWorkspaceForOrg } from '@weldsuite/worker-kit/db';
import { consumeInstallNonce } from '@weldsuite/connect-domain/github/install-state';
import { proveGithubInstallationAccess } from '@weldsuite/connect-domain/github/user-installations';
import {
  GithubInstallationTakenError,
  releaseGithubInstallationIndex,
  setGithubInstallationStatus,
} from '@weldsuite/merge-domain/installations';
import { storedMemberGithubToken } from '@weldsuite/merge-domain/member-token';
import { logSafe } from '@weldsuite/worker-kit/log-safe';
import { workspaceAppUrl } from '@weldsuite/worker-kit/app-url';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// The browser must land back on the platform app, not on app-api. Error
// redirects use this absolute base; success uses the absolute `returnTo`.
// Once the state JWT names the workspace, redirects land in it (`/w/{orgId}/…`, FE-013).
const APP_BASE = 'https://app.weldsuite.org';
const settingsPath = (qs: string, workspaceId?: string) =>
  workspaceAppUrl(APP_BASE, workspaceId, `/settings/integrations/github${qs}`);

app.get('/callback', async (c) => {
  const query = c.req.query();
  const installationId = query.installation_id ? Number(query.installation_id) : null;
  const setupAction = query.setup_action;
  const stateToken = query.state;
  const code = query.code;

  if (!installationId || !stateToken) {
    return c.redirect(settingsPath('?error=missing_params'));
  }

  const claims = await verifyInstallStateJwt(stateToken, c.env.CLERK_SECRET_KEY);
  if (!claims) {
    return c.redirect(settingsPath('?error=invalid_state'));
  }

  const { workspaceId, returnTo } = claims;
  const successRedirect = returnTo || settingsPath('?installed=1', workspaceId);

  const encryptionKey = { v1: c.env.DATABASE_ENCRYPTION_KEY, v2: c.env.DATABASE_ENCRYPTION_KEY_V2 };
  if (!encryptionKey.v1 && !encryptionKey.v2) {
    console.error('[GitHub] DATABASE_ENCRYPTION_KEY is not configured');
    return c.redirect(settingsPath('?error=configuration_error', workspaceId));
  }

  const appId = c.env.GITHUB_APP_ID;
  const privateKey = c.env.GITHUB_APP_PRIVATE_KEY;
  const kv = c.env.WORKSPACE_CACHE;
  if (!appId || !privateKey || !kv) {
    console.error('[GitHub] GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY or WORKSPACE_CACHE is not configured');
    return c.redirect(settingsPath('?error=configuration_error', workspaceId));
  }

  try {
    // A state is redeemed once: a replay (or a state never issued) stops here.
    if (!(await consumeInstallNonce(kv, claims.nonce))) {
      return c.redirect(settingsPath('?error=state_expired', workspaceId));
    }

    const db = await getTenantDbForWorkspace(c.env, workspaceId);

    if (setupAction === 'delete') {
      // Only this workspace's connection, and the index row only when it names this workspace.
      const workspace = await getWorkspaceForOrg(c.env, workspaceId);
      await setGithubInstallationStatus(db, installationId, 'revoked');
      await releaseGithubInstallationIndex(getMasterDb(c.env), installationId, workspace.id);
      return c.redirect(settingsPath('?disconnected=1', workspaceId));
    }

    const reachable = await proveGithubInstallationAccess(installationId, {
      code,
      clientId: c.env.GITHUB_APP_CLIENT_ID,
      clientSecret: c.env.GITHUB_APP_CLIENT_SECRET,
      memberToken: () => storedMemberGithubToken(db, encryptionKey, claims.userId),
    });
    if (!reachable) {
      return c.redirect(settingsPath('?error=installation_unverified', workspaceId));
    }

    const meta = await fetchInstallationMeta(appId, privateKey, installationId);

    // The installation becomes the workspace's WeldMerge connection (merge_connections + the master index).
    await recordInstallation(c.env, db, workspaceId, {
      installationId,
      appSlug: meta.appSlug,
      accountLogin: meta.accountLogin,
      accountType: meta.accountType,
      userId: claims.userId,
      keyring: encryptionKey,
    });

    console.log(`[GitHub] Installation ${installationId} persisted for workspace ${workspaceId}`);
    return c.redirect(successRedirect);
  } catch (err) {
    if (err instanceof GithubInstallationTakenError) {
      return c.redirect(settingsPath('?error=installation_taken', workspaceId));
    }
    const e = err as { message?: string; cause?: unknown };
    console.error(
      '[GitHub] Callback error:',
      logSafe(e?.message),
      '| cause:',
      logSafe(e?.cause instanceof Error ? e.cause.message : e?.cause),
    );
    return c.redirect(settingsPath('?error=internal_error', workspaceId));
  }
});

export { app as githubCallbackRoutes };
