/**
 * The GitHub App's setup redirect: /public/merge/github/setup (no Clerk session).
 *
 *   GET /setup?installation_id&setup_action&state&code
 *     -> verifies the signed state (routes/connections/github-install.ts issued it) and takes its
 *        nonce (a state is good once), proves the installing member can reach the installation
 *        (`memberCanReachInstallation`: GitHub's `code`, else their linked GitHub account, must list
 *        it in `GET /user/installations`), reads the installation's account with the App JWT,
 *        records it (`recordGithubInstallation`: the master installation index, claimed for this
 *        workspace, and the merge_connections row), publishes merge_connection created/updated
 *        and redirects to `returnTo` (default /weldmerge/settings?tab=providers&installed=1).
 *
 * The state decides the workspace: the tenant DB is resolved from its
 * `workspaceId`. `installation_id` is GitHub's word only once a user token
 * proves it. Failures redirect back to the providers tab with `error=<code>`
 * (missing_params, invalid_state, state_expired, workspace_unavailable,
 * configuration_error, installation_unverified, installation_taken,
 * internal_error). `setup_action=delete` revokes the installation's connection
 * in this workspace and drops its index row only when it names this workspace.
 */

import { Hono } from 'hono';
import { keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { getMasterDb, getWorkspaceContextForOrg } from '@weldsuite/worker-kit/db';
import { logSafe } from '@weldsuite/worker-kit/log-safe';
import { consumeInstallNonce, verifyInstallStateJwt } from '@weldsuite/connect-domain/github/install-state';
import { fetchGithubInstallationMeta } from '@weldsuite/connect-domain/github/app-auth';
import {
  GithubInstallationTakenError,
  recordGithubInstallation,
  releaseGithubInstallationIndex,
  setGithubInstallationStatus,
} from '@weldsuite/merge-domain/installations';
import { mergeGithubSetupQuerySchema } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import type { Env, Variables } from '../../types';
import { publishEntityEvents } from '../../services/events';
import {
  memberCanReachInstallation,
  setupDisconnectedRedirect,
  setupErrorRedirect,
  setupRedirect,
} from '../../services/github-install';
import { connectionEventData } from '../../services/repositories';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/setup', async (c) => {
  const appUrl = c.env.APP_URL;
  const parsed = mergeGithubSetupQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return c.redirect(setupErrorRedirect(appUrl, null, 'missing_params'));
  const { installation_id: installationId, setup_action: setupAction, state, code } = parsed.data;

  const claims = await verifyInstallStateJwt(state, c.env.CLERK_SECRET_KEY);
  if (!claims) return c.redirect(setupErrorRedirect(appUrl, null, 'invalid_state'));

  let workspace: Awaited<ReturnType<typeof getWorkspaceContextForOrg>>;
  try {
    workspace = await getWorkspaceContextForOrg(c.env, claims.workspaceId);
  } catch {
    return c.redirect(setupErrorRedirect(appUrl, null, 'workspace_unavailable'));
  }
  if (workspace.suspended) return c.redirect(setupErrorRedirect(appUrl, workspace.clerkOrgId, 'workspace_unavailable'));
  const fail = (reason: string) => c.redirect(setupErrorRedirect(appUrl, workspace.clerkOrgId, reason));

  const keyring = keyringFromEnv(c.env);
  if (!keyring.v1 && !keyring.v2) return fail('configuration_error');
  const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKey, WORKSPACE_CACHE: kv } = c.env;
  if (!appId || !privateKey || !kv) return fail('configuration_error');

  // Events are the installing member's, in this workspace.
  c.set('workspaceId', workspace.id);
  c.set('clerkOrgId', workspace.clerkOrgId ?? claims.workspaceId);
  c.set('userId', claims.userId);

  try {
    // A state is redeemed once: a replay (or a state never issued) stops here.
    if (!(await consumeInstallNonce(kv, claims.nonce))) return fail('state_expired');

    const masterDb = getMasterDb(c.env);
    if (setupAction === 'delete') {
      const revoked = await setGithubInstallationStatus(workspace.db, installationId, 'revoked');
      await releaseGithubInstallationIndex(masterDb, installationId, workspace.id);
      publishEntityEvents(
        c,
        revoked.map((row) => ({ entityType: 'merge_connection' as const, action: 'updated' as const, entityId: row.id, data: connectionEventData(row) })),
      );
      return c.redirect(setupDisconnectedRedirect(appUrl, workspace.clerkOrgId));
    }

    if (!(await memberCanReachInstallation(c.env, workspace.db, claims.userId, installationId, code))) {
      return fail('installation_unverified');
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
    if (err instanceof GithubInstallationTakenError) return fail('installation_taken');
    console.error('[merge-api] GitHub setup failed:', logSafe(err instanceof Error ? err.message : String(err)));
    return fail('internal_error');
  }
});

export default app;
