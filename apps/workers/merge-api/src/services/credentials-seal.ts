/**
 * Sealing and opening a credentials blob (`{accessToken, refreshToken?,
 * expiresAt?, tokenType?}`) under the `DATABASE_ENCRYPTION_KEY` keyring. Kept
 * apart from `credentials.ts` (which refreshes tokens through the provider
 * adapters) so the adapters can open a stored token without importing the
 * module that imports them. `credentials.ts` re-exports both.
 */

import { decryptField, encryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { mergeStoredCredentialsSchema, type MergeStoredCredentials } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { Env } from '../types';

export type KeyEnv = Pick<Env, 'DATABASE_ENCRYPTION_KEY' | 'DATABASE_ENCRYPTION_KEY_V2'>;

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
