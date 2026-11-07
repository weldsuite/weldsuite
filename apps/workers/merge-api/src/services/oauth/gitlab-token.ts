/**
 * Self-managed GitLab connects with an access token (the OAuth app belongs to
 * gitlab.com): one for the workspace connection, one personal token per member
 * for review and merge. Both are validated with `GET {host}/api/v4/user`; a token
 * for gitlab.com itself works the same way. Only `https` hosts are accepted.
 */

import type { Env } from '../../types';
import type { Db, MergeConnectionRow, MergeProviderAccountRow } from '../db';
import { gitlabCurrentUser } from '../providers/gitlab/oauth';
import { isStatus } from '../providers/provider-http';
import { ProviderApiError, type OAuthUser } from '../providers/types';
import { linkProviderAccount } from './accounts';
import { normalizeGitlabHost } from './authorize';
import { upsertOAuthConnection } from './connections';

export type TokenFailure = { ok: false; reason: 'invalid_host' | 'token_rejected'; message: string };

interface ValidToken {
  ok: true;
  /** Normalized host: null for gitlab.com. */
  host: string | null;
  user: OAuthUser;
}

/** Checks the host is https and the token is accepted; says whose it is. */
export async function validateGitlabToken(host: string, token: string): Promise<ValidToken | TokenFailure> {
  let normalized: string | null;
  try {
    if (new URL(host).protocol !== 'https:') throw new Error('not https');
    normalized = normalizeGitlabHost(host);
  } catch {
    return { ok: false, reason: 'invalid_host', message: 'The GitLab host must be an https URL' };
  }
  try {
    return { ok: true, host: normalized, user: await gitlabCurrentUser(normalized, token) };
  } catch (err) {
    if (err instanceof ProviderApiError && isStatus(err, 401, 403)) {
      return { ok: false, reason: 'token_rejected', message: err.message };
    }
    throw err;
  }
}

/** The account id of a token connection: unique per host and GitLab user. */
function externalAccountId(host: string | null, user: OAuthUser): string {
  if (!host) return user.externalId;
  const url = new URL(host);
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}:${user.externalId}`;
}

export type ConnectTokenResult = { ok: true; connection: MergeConnectionRow; created: boolean } | TokenFailure;

export async function connectGitlabWithToken(db: Db, env: Env, userId: string, host: string, token: string): Promise<ConnectTokenResult> {
  const valid = await validateGitlabToken(host, token);
  if (!valid.ok) return valid;
  const { connection, created } = await upsertOAuthConnection(db, env, {
    provider: 'gitlab',
    userId,
    externalAccountId: externalAccountId(valid.host, valid.user),
    accountLogin: valid.user.login,
    accountType: 'user',
    host: valid.host,
    oauthUserLogin: valid.user.login,
    credentials: { accessToken: token, tokenType: 'Bearer' },
  });
  return { ok: true, connection, created };
}

export type LinkTokenResult = { ok: true; account: MergeProviderAccountRow } | { ok: false; reason: 'login_taken' } | TokenFailure;

export async function linkGitlabWithToken(db: Db, env: Env, userId: string, host: string, token: string): Promise<LinkTokenResult> {
  const valid = await validateGitlabToken(host, token);
  if (!valid.ok) return valid;
  return linkProviderAccount(db, env, {
    userId,
    provider: 'gitlab',
    host: valid.host,
    user: valid.user,
    credentials: { accessToken: token, tokenType: 'Bearer' },
  });
}
