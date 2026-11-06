/**
 * A member's own GitHub token, read from their linked WeldMerge account
 * (`merge_provider_accounts`, provider `github`, verified through OAuth), for a
 * worker that holds the keyring but not the App's OAuth client: connect-api
 * proves an install with it. The token is used as stored, never refreshed:
 * an expired one is no token (the member links the account again in
 * WeldMerge). merge-api uses its own `getMemberToken`, which refreshes.
 */

import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { mergeProviderAccounts } from '@weldsuite/db/schema';
import { decryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { mergeStoredCredentialsSchema } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { InstallationDb } from './installations';

/** The member's verified GitHub token while it has not expired; null otherwise. */
export async function storedMemberGithubToken(
  tenantDb: InstallationDb,
  keyring: EncryptionKeyring,
  userId: string,
  now: Date = new Date(),
): Promise<string | null> {
  if (!userId) return null;
  const [account] = await tenantDb
    .select({ credentials: mergeProviderAccounts.credentials })
    .from(mergeProviderAccounts)
    .where(
      and(
        eq(mergeProviderAccounts.userId, userId),
        eq(mergeProviderAccounts.provider, 'github'),
        isNull(mergeProviderAccounts.host),
        isNotNull(mergeProviderAccounts.verifiedAt),
      ),
    )
    .limit(1);
  if (!account?.credentials) return null;
  try {
    const parsed = mergeStoredCredentialsSchema.safeParse(JSON.parse(await decryptField(account.credentials, keyring)));
    if (!parsed.success) return null;
    const { accessToken, expiresAt } = parsed.data;
    if (expiresAt && new Date(expiresAt).getTime() <= now.getTime()) return null;
    return accessToken || null;
  } catch {
    return null;
  }
}
