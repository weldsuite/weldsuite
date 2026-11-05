/**
 * Provider credentials at rest. Connection and member-account tokens are stored
 * as one encrypted JSON blob (`{accessToken, refreshToken?, expiresAt?,
 * tokenType?}`) under the `DATABASE_ENCRYPTION_KEY` keyring, and never leave
 * the backend: no DTO carries them and no entity event does (EVT-005).
 *
 * Area B turns the plain decrypt in `getMemberToken` / `getConnectionToken`
 * into "decrypt, refresh when `expiresAt` is within 5 minutes, store the new
 * credentials, and mark the connection `needs_attention` when the refresh
 * fails".
 */

import { and, eq, isNull } from 'drizzle-orm';
import { decryptField, encryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import { mergeStoredCredentialsSchema, type MergeStoredCredentials } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { Env } from '../types';
import { mergeProviderAccounts, type Db, type MergeConnectionRow } from './db';

type KeyEnv = Pick<Env, 'DATABASE_ENCRYPTION_KEY' | 'DATABASE_ENCRYPTION_KEY_V2'>;

/** Encrypts credentials for a `credentials` column. */
export async function sealCredentials(env: KeyEnv, credentials: MergeStoredCredentials): Promise<string> {
  return encryptField(JSON.stringify(credentials), keyringFromEnv(env));
}

/** Decrypts a `credentials` column; null when it is empty or unreadable. */
export async function openCredentials(env: KeyEnv, sealed: string | null | undefined): Promise<MergeStoredCredentials | null> {
  if (!sealed) return null;
  try {
    const parsed = mergeStoredCredentialsSchema.safeParse(JSON.parse(await decryptField(sealed, keyringFromEnv(env))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A token to use on a provider, and who it belongs to. */
export interface ResolvedToken {
  accessToken: string;
  tokenType: string | null;
  /** The linked account's login, for member tokens. */
  login?: string;
}

/**
 * The member's own token for a provider (review and merge run as the member),
 * or null when they have no verified linked account (409 `account_not_linked`).
 * `host`: self-managed GitLab base URL or Azure DevOps organisation URL.
 */
export async function getMemberToken(
  db: Db,
  env: KeyEnv,
  userId: string,
  provider: MergeProvider,
  host?: string | null,
): Promise<ResolvedToken | null> {
  const [account] = await db
    .select()
    .from(mergeProviderAccounts)
    .where(
      and(
        eq(mergeProviderAccounts.userId, userId),
        eq(mergeProviderAccounts.provider, provider),
        host ? eq(mergeProviderAccounts.host, host) : isNull(mergeProviderAccounts.host),
      ),
    )
    .limit(1);
  if (!account || !account.verifiedAt) return null;
  const credentials = await openCredentials(env, account.credentials);
  if (!credentials) return null;
  return { accessToken: credentials.accessToken, tokenType: credentials.tokenType ?? null, login: account.login };
}

/**
 * The connection's own token (GitLab, Bitbucket, Azure DevOps). GitHub has none:
 * its installation tokens are minted per call. Null when the connection stores no credentials.
 */
export async function getConnectionToken(_db: Db, env: KeyEnv, connection: MergeConnectionRow): Promise<ResolvedToken | null> {
  const credentials = await openCredentials(env, connection.credentials);
  if (!credentials) return null;
  return { accessToken: credentials.accessToken, tokenType: credentials.tokenType ?? null };
}
