/**
 * GitHub-specific helpers for the generic `/api/workflow-integrations`
 * surface. Unlike Slack (`./slack.ts`, OAuth2), GitHub uses `app_installation`
 * auth (`@weldsuite/workflow-integrations`' `AppInstallationConfig`): instead
 * of a second OAuth app, WeldConnect reuses the GitHub App installation
 * WeldFlow's project sync already sets up per workspace
 * (`github_connections`, `services/github/connections.ts`). "Connecting"
 * GitHub for WeldConnect is therefore just pointing a `workflow_integrations`
 * row at that existing installation — see "Provider pattern" in
 * docs/plans/weldconnect.md.
 */

import { eq, and, isNull } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { getGithubInstallationToken } from '@weldsuite/connect-domain/github/app-auth';
import type { AvailableRepo } from '@weldsuite/core-api-client/schemas/github';
import { getConnectionByWorkspace } from '../github/connections';
import { listAvailableRepos } from '../github/repos';

const wi = schema.workflowIntegrations;

export interface GithubAppCredentials {
  appId: string;
  privateKey: string;
}

export type LinkGithubInstallationResult =
  | { linked: true; integrationId: string }
  | { linked: false };

/**
 * Point a `workflow_integrations` row of type `github` at the workspace's
 * existing GitHub App installation, creating or updating it. Returns
 * `linked: false` when no active installation exists yet — the caller
 * (route) tells the user to connect the App from Settings → Integrations →
 * GitHub first; WeldConnect does not re-implement that install flow.
 */
export async function linkGithubAppInstallation(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<LinkGithubInstallationResult> {
  const connection = await getConnectionByWorkspace(db, workspaceId);
  if (!connection || connection.status !== 'active') {
    return { linked: false };
  }

  const now = new Date();
  const settings = {
    installationId: connection.installationId,
    ownerLogin: connection.ownerLogin,
    ownerType: connection.ownerType,
    appSlug: connection.appSlug,
  };

  const [existing] = await db
    .select({ id: wi.id })
    .from(wi)
    .where(and(eq(wi.type, 'github'), isNull(wi.deletedAt)))
    .limit(1);

  if (existing) {
    await db
      .update(wi)
      .set({
        status: 'connected',
        settings,
        connectedAt: now,
        connectedBy: userId,
        updatedAt: now,
      })
      .where(eq(wi.id, existing.id));
    return { linked: true, integrationId: existing.id };
  }

  const id = generateId('int');
  await db.insert(wi).values({
    id,
    createdAt: now,
    updatedAt: now,
    name: 'GitHub',
    type: 'github',
    category: 'developer',
    icon: 'github',
    status: 'connected',
    settings,
    connectedAt: now,
    connectedBy: userId,
  });
  return { linked: true, integrationId: id };
}

/** Mint a fresh installation token for a connected `github` integration row. */
async function installationToken(
  creds: GithubAppCredentials,
  settings: Record<string, unknown> | undefined,
): Promise<string> {
  const installationId = Number(settings?.installationId);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error('GitHub integration has no valid installation configured');
  }
  return getGithubInstallationToken(creds.appId, creds.privateKey, installationId);
}

/**
 * Cheap reachability check — minting a fresh installation token already
 * proves the App's key is valid and the installation itself is still active:
 * GitHub 401s a bad app key and 404s an installation that was uninstalled
 * from the GitHub side, both of which `getGithubInstallationToken` surfaces
 * as a rejected promise. No separate REST call needed.
 */
export async function testGithubAuth(
  creds: GithubAppCredentials,
  settings: Record<string, unknown> | undefined,
): Promise<{ ok: boolean; message: string }> {
  try {
    await installationToken(creds, settings);
    const ownerLogin = typeof settings?.ownerLogin === 'string' ? settings.ownerLogin : 'GitHub';
    return { ok: true, message: `Connected to ${ownerLogin}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'GitHub connection check failed' };
  }
}

/** Repositories the installation can access — the step form's repo picker. */
export async function listGithubRepos(
  creds: GithubAppCredentials,
  settings: Record<string, unknown> | undefined,
): Promise<AvailableRepo[]> {
  const token = await installationToken(creds, settings);
  return listAvailableRepos(token);
}
