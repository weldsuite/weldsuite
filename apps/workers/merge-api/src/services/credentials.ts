/**
 * Provider credentials at rest. Connection and member-account tokens are stored
 * as one encrypted JSON blob (`{accessToken, refreshToken?, expiresAt?,
 * tokenType?}`) under the `DATABASE_ENCRYPTION_KEY` keyring, and never leave
 * the backend: no DTO carries them and no entity event does (EVT-005).
 *
 * `getMemberToken` / `getConnectionToken` decrypt, and refresh first when
 * `expiresAt` is within five minutes: the new credentials replace the stored
 * ones. A refresh the provider refuses marks the connection `needs_attention`
 * (a member account loses its credentials and its `verified_at`, so the member
 * links it again: `account_not_linked`).
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { MergeStoredCredentials } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { Env } from '../types';
import { openCredentials, sealCredentials, type KeyEnv } from './credentials-seal';
import { mergeConnections, mergeProviderAccounts, type Db, type MergeConnectionRow } from './db';
import { oauthFor } from './providers/registry';

export { openCredentials, sealCredentials };

/** The keyring plus whatever the provider's OAuth app needs to refresh (the full `Env` in a worker). */
export type CredentialsEnv = KeyEnv & Partial<Env>;

/** A token to use on a provider, and who it belongs to. */
export interface ResolvedToken {
  accessToken: string;
  tokenType: string | null;
  /** The linked account's login, for member tokens. */
  login?: string;
}

/** A token is refreshed when it expires within this long. */
export const REFRESH_WINDOW_MS = 5 * 60 * 1000;

/** Whether the credentials should be refreshed now (they carry an expiry that is near, and a refresh token to use). */
export function needsRefresh(credentials: MergeStoredCredentials, now: Date): boolean {
  if (!credentials.refreshToken || !credentials.expiresAt) return false;
  return new Date(credentials.expiresAt).getTime() - now.getTime() < REFRESH_WINDOW_MS;
}

/** Asks the provider for new credentials; a rotated refresh token replaces the old one, an unchanged one stays. */
async function refreshedCredentials(
  env: CredentialsEnv,
  provider: MergeProvider,
  host: string | null,
  credentials: MergeStoredCredentials,
): Promise<MergeStoredCredentials> {
  const fresh = await oauthFor(provider).refresh(env as Env, { refreshToken: credentials.refreshToken!, host });
  return { ...fresh, refreshToken: fresh.refreshToken ?? credentials.refreshToken };
}

const expiry = (credentials: MergeStoredCredentials): Date | null =>
  credentials.expiresAt ? new Date(credentials.expiresAt) : null;

/**
 * Which linked account a host selects: self-managed GitLab accounts are per host. An Azure DevOps
 * account is the member's Entra sign-in, valid for every organisation they belong to, so it has no
 * host and the connection's organisation URL does not narrow it.
 */
function accountHostFilter(provider: MergeProvider, host: string | null | undefined) {
  if (provider === 'azure_devops') return undefined;
  return host ? eq(mergeProviderAccounts.host, host) : isNull(mergeProviderAccounts.host);
}

/**
 * The member's own token for a provider (review and merge run as the member),
 * or null when they have no verified linked account (409 `account_not_linked`).
 * `host`: the self-managed GitLab base URL (an Azure DevOps account has no host: see `accountHostFilter`).
 */
export async function getMemberToken(
  db: Db,
  env: CredentialsEnv,
  userId: string,
  provider: MergeProvider,
  host?: string | null,
  now: Date = new Date(),
): Promise<ResolvedToken | null> {
  const [account] = await db
    .select()
    .from(mergeProviderAccounts)
    .where(
      and(
        eq(mergeProviderAccounts.userId, userId),
        eq(mergeProviderAccounts.provider, provider),
        accountHostFilter(provider, host),
      ),
    )
    .limit(1);
  if (!account || !account.verifiedAt) return null;
  let credentials = await openCredentials(env, account.credentials);
  if (!credentials) return null;

  if (needsRefresh(credentials, now)) {
    try {
      credentials = await refreshedCredentials(env, provider, account.host, credentials);
    } catch (err) {
      console.error(`[merge-api] ${provider} token refresh failed for a member account:`, err);
      await db
        .update(mergeProviderAccounts)
        .set({ credentials: null, credentialsExpireAt: null, verifiedAt: null, updatedAt: now })
        .where(eq(mergeProviderAccounts.id, account.id));
      return null;
    }
    await db
      .update(mergeProviderAccounts)
      .set({ credentials: await sealCredentials(env, credentials), credentialsExpireAt: expiry(credentials), updatedAt: now })
      .where(eq(mergeProviderAccounts.id, account.id));
  }
  return { accessToken: credentials.accessToken, tokenType: credentials.tokenType ?? null, login: account.login };
}

/**
 * The connection's own token (GitLab, Bitbucket, Azure DevOps). GitHub has none:
 * its installation tokens are minted per call. Null when the connection stores
 * no credentials, or its refresh failed (the connection is then `needs_attention`).
 */
export async function getConnectionToken(
  db: Db,
  env: CredentialsEnv,
  connection: MergeConnectionRow,
  now: Date = new Date(),
): Promise<ResolvedToken | null> {
  let credentials = await openCredentials(env, connection.credentials);
  if (!credentials) return null;

  if (needsRefresh(credentials, now)) {
    try {
      credentials = await refreshedCredentials(env, connection.provider, connection.host, credentials);
    } catch (err) {
      console.error(`[merge-api] ${connection.provider} token refresh failed for connection ${connection.id}:`, err);
      await db
        .update(mergeConnections)
        .set({ status: 'needs_attention', updatedAt: now })
        .where(eq(mergeConnections.id, connection.id));
      return null;
    }
    await db
      .update(mergeConnections)
      .set({
        credentials: await sealCredentials(env, credentials),
        credentialsExpireAt: expiry(credentials),
        status: connection.status === 'needs_attention' ? 'active' : connection.status,
        updatedAt: now,
      })
      .where(eq(mergeConnections.id, connection.id));
  }
  return { accessToken: credentials.accessToken, tokenType: credentials.tokenType ?? null };
}
