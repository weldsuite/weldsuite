/**
 * Whether the person at the GitHub App's install redirect can reach the
 * installation it names. GitHub documents the redirect's `installation_id` as
 * spoofable, and the App JWT reads every installation, so an install route
 * records an installation only once a GitHub user token proves access to it:
 * the installation is listed by `GET /user/installations` for that user.
 *
 * The token comes from the `code` GitHub adds to the redirect when the App
 * has "Request user authorization (OAuth) during installation" on, else from
 * the member's linked GitHub account. merge-api's setup route and connect-api's
 * callback and recover all ask `proveGithubInstallationAccess` (the Rust
 * backend: `weldsuite_connect_domain::github_user`), so the calls they make are
 * the same.
 */

export const GITHUB_OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_INSTALLATIONS_URL = 'https://api.github.com/user/installations';
/** Installations per page of `GET /user/installations` (GitHub's maximum). */
export const USER_INSTALLATIONS_PER_PAGE = 100;
/** Pages read at most: a thousand installations per user. */
export const USER_INSTALLATIONS_MAX_PAGES = 10;

const USER_AGENT = 'WeldSuite-WeldMerge';

/**
 * Exchanges the install redirect's `code` for a user token of the App. Null
 * when GitHub refuses it (it answers 200 with an `error` field for a bad or
 * used code); throws only when GitHub cannot be reached.
 */
export async function exchangeGithubUserCode(clientId: string, clientSecret: string, code: string): Promise<string | null> {
  const res = await fetch(GITHUB_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  return typeof body?.access_token === 'string' && body.access_token ? body.access_token : null;
}

/**
 * Whether `installationId` is among the installations the user token can
 * reach, page by page (at most `USER_INSTALLATIONS_MAX_PAGES`). A token GitHub
 * refuses reaches none.
 */
export async function githubUserCanAccessInstallation(userToken: string, installationId: number | string): Promise<boolean> {
  const wanted = String(installationId);
  for (let page = 1; page <= USER_INSTALLATIONS_MAX_PAGES; page++) {
    const res = await fetch(`${GITHUB_USER_INSTALLATIONS_URL}?per_page=${USER_INSTALLATIONS_PER_PAGE}&page=${page}`, {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
      },
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { installations?: Array<{ id?: unknown }> } | null;
    const installations = Array.isArray(body?.installations) ? body.installations : [];
    if (installations.some((installation) => String(installation?.id) === wanted)) return true;
    if (installations.length < USER_INSTALLATIONS_PER_PAGE) return false;
  }
  return false;
}

export interface InstallationAccessEvidence {
  /** The `code` of the install redirect, if GitHub sent one. */
  code?: string | null;
  /** The App's OAuth client (`GITHUB_APP_CLIENT_ID` / `_SECRET`); without it a `code` is not exchanged. */
  clientId?: string | null;
  clientSecret?: string | null;
  /** The member's own GitHub token, asked for only when the `code` proved nothing. */
  memberToken?: () => Promise<string | null>;
}

/**
 * True when a GitHub user token proves access to the installation: the one the
 * `code` is exchanged for, else the member's own. False when neither does
 * (the caller refuses with `installation_unverified`).
 */
export async function proveGithubInstallationAccess(
  installationId: number | string,
  evidence: InstallationAccessEvidence,
): Promise<boolean> {
  if (evidence.code && evidence.clientId && evidence.clientSecret) {
    const token = await exchangeGithubUserCode(evidence.clientId, evidence.clientSecret, evidence.code);
    if (token && (await githubUserCanAccessInstallation(token, installationId))) return true;
  }
  const memberToken = evidence.memberToken ? await evidence.memberToken() : null;
  return memberToken ? githubUserCanAccessInstallation(memberToken, installationId) : false;
}
