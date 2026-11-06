/**
 * GitHub App install flow, the parts that need no Hono context: the install
 * page URL, the `returnTo` rule, where the setup redirect sends the browser,
 * and the proof that the installing member can reach the installation.
 * The signed state itself is `@weldsuite/connect-domain/github/install-state`
 * (shared with connect-api's flow).
 */

import { workspaceAppUrl } from '@weldsuite/worker-kit/app-url';
import { MERGE_GITHUB_INSTALL_DEFAULT_RETURN } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import { proveGithubInstallationAccess } from '@weldsuite/connect-domain/github/user-installations';
import type { Env } from '../types';
import type { Db } from './db';
import { getMemberToken } from './credentials';

/** The platform's origin when `APP_URL` is not set. */
export const DEFAULT_APP_URL = 'https://app.weldsuite.org';

/** The App's install page; with a state, GitHub sends it back to the setup URL. */
export function githubInstallPage(appSlug: string, state?: string): string {
  const base = `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;
  return state ? `${base}?state=${encodeURIComponent(state)}` : base;
}

/** A same-app relative path (`/…`, not `//host`), or undefined: anything else is ignored. */
export function sameAppPath(returnTo: string | null | undefined): string | undefined {
  if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('\\')) return undefined;
  return returnTo;
}

/** Where the browser lands: inside the workspace (`/w/<org>/…`, FE-013) when its Clerk org id is known. */
export function setupRedirect(
  appUrl: string | undefined,
  clerkOrgId: string | null | undefined,
  returnTo: string | null | undefined,
): string {
  const path = sameAppPath(returnTo) ?? MERGE_GITHUB_INSTALL_DEFAULT_RETURN;
  return workspaceAppUrl(appUrl || DEFAULT_APP_URL, clerkOrgId, path);
}

/** The error page of the setup redirect: the providers tab with `error=<code>`. */
export function setupErrorRedirect(appUrl: string | undefined, clerkOrgId: string | null | undefined, code: string): string {
  return workspaceAppUrl(appUrl || DEFAULT_APP_URL, clerkOrgId, `/weldmerge/settings?tab=providers&error=${code}`);
}

/**
 * Whether the installing member can reach the installation the redirect names
 * (its `installation_id` can be spoofed): the user of GitHub's `code` (the App
 * requests user authorization during installation), else the member's own
 * linked GitHub account, must see it in `GET /user/installations`.
 */
export function memberCanReachInstallation(
  env: Env,
  db: Db,
  userId: string,
  installationId: string,
  code: string | undefined,
): Promise<boolean> {
  return proveGithubInstallationAccess(installationId, {
    code,
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    memberToken: async () => (await getMemberToken(db, env, userId, 'github'))?.accessToken ?? null,
  });
}

/** After the App was uninstalled from GitHub: the providers tab, `disconnected=1`. */
export function setupDisconnectedRedirect(appUrl: string | undefined, clerkOrgId: string | null | undefined): string {
  return workspaceAppUrl(appUrl || DEFAULT_APP_URL, clerkOrgId, '/weldmerge/settings?tab=providers&disconnected=1');
}
