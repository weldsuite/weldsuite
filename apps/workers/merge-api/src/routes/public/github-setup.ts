/**
 * The GitHub App's setup redirect: /public/merge/github/setup (no Clerk session).
 *
 *   GET /setup?installation_id&setup_action&state
 *     -> verifies the signed state (routes/connections/github-install.ts issued it), reads the
 *        installation's account with the App JWT, records it (`recordGithubInstallation`:
 *        the merge_connections row and the master installation index), publishes
 *        merge_connection created/updated and redirects to `returnTo`
 *        (default /weldmerge/settings?tab=providers&installed=1).
 *
 * The state decides the workspace: the tenant DB is resolved from its
 * `workspaceId`. Failures redirect back to the providers tab with `error=<code>`
 * (missing_params, invalid_state, workspace_unavailable, configuration_error,
 * internal_error). `setup_action=delete` revokes the installation instead.
 */

import { Hono } from 'hono';
import { keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { getMasterDb, getWorkspaceContextForOrg } from '@weldsuite/worker-kit/db';
import { logSafe } from '@weldsuite/worker-kit/log-safe';
import { verifyInstallStateJwt } from '@weldsuite/connect-domain/github/install-state';
import { fetchGithubInstallationMeta } from '@weldsuite/connect-domain/github/app-auth';
import {
  recordGithubInstallation,
  removeGithubInstallationIndex,
  setGithubInstallationStatus,
} from '@weldsuite/merge-domain/installations';
import { mergeGithubSetupQuerySchema } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import type { Env, Variables } from '../../types';
import { publishEntityEvents } from '../../services/events';
import { setupDisconnectedRedirect, setupErrorRedirect, setupRedirect } from '../../services/github-install';
import { connectionEventData } from '../../services/repositories';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/setup', async (c) => {
  const appUrl = c.env.APP_URL;
  const parsed = mergeGithubSetupQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return c.redirect(setupErrorRedirect(appUrl, null, 'missing_params'));
  const { installation_id: installationId, setup_action: setupAction, state } = parsed.data;

  const claims = await verifyInstallStateJwt(state, c.env.CLERK_SECRET_KEY);
  if (!claims) return c.redirect(setupErrorRedirect(appUrl, null, 'invalid_state'));

  let workspace: Awaited<ReturnType<typeof getWorkspaceContextForOrg>>;
  try {
    workspace = await getWorkspaceContextForOrg(c.env, claims.workspaceId);
  } catch {
    return c.redirect(setupErrorRedirect(appUrl, null, 'workspace_unavailable'));
  }
  if (workspace.suspended) return c.redirect(setupErrorRedirect(appUrl, workspace.clerkOrgId, 'workspace_unavailable'));
  const fail = (code: string) => c.redirect(setupErrorRedirect(appUrl, workspace.clerkOrgId, code));

  const keyring = keyringFromEnv(c.env);
  if (!keyring.v1 && !keyring.v2) return fail('configuration_error');
  const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKey } = c.env;
  if (!appId || !privateKey) return fail('configuration_error');

  // Events are the installing member's, in this workspace.
  c.set('workspaceId', workspace.id);
  c.set('clerkOrgId', workspace.clerkOrgId ?? claims.workspaceId);
  c.set('userId', claims.userId);

  try {
    const masterDb = getMasterDb(c.env);
    if (setupAction === 'delete') {
      const revoked = await setGithubInstallationStatus(workspace.db, installationId, 'revoked');
      await removeGithubInstallationIndex(masterDb, installationId);
      publishEntityEvents(
        c,
        revoked.map((row) => ({ entityType: 'merge_connection' as const, action: 'updated' as const, entityId: row.id, data: connectionEventData(row) })),
      );
      return c.redirect(setupDisconnectedRedirect(appUrl, workspace.clerkOrgId));
    }

    const meta = await fetchGithubInstallationMeta(appId, privateKey, Number(installationId));
    const { connection, action } = await recordGithubInstallation(workspace.db, masterDb, {
      installationId,
      appSlug: meta.appSlug,
      accountLogin: meta.accountLogin,
      accountType: meta.accountType,
      workspaceId: workspace.id,
      userId: claims.userId,
      keyring,
    });
    publishEntityEvents(c, [
      { entityType: 'merge_connection', action, entityId: connection.id, data: connectionEventData(connection) },
    ]);
    return c.redirect(setupRedirect(appUrl, workspace.clerkOrgId, claims.returnTo));
  } catch (err) {
    console.error('[merge-api] GitHub setup failed:', logSafe(err instanceof Error ? err.message : String(err)));
    return fail('internal_error');
  }
});

export default app;
