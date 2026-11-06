/**
 * Member accounts linked through OAuth (or a validated self-managed GitLab
 * token): the member's own credentials on a provider, so review and merge run
 * as them. One account per member, provider and host (`merge_provider_accounts`);
 * `verified_at` is set because the provider vouched for the login. Linking also
 * claims the pull requests that login authored.
 */

import { and, eq, isNull, ne } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { MergeStoredCredentials } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { Env } from '../../types';
import { sealCredentials } from '../credentials';
import { mergeProviderAccounts, mergePullRequests, type Db, type MergeProviderAccountRow } from '../db';
import type { OAuthUser } from '../providers/types';

export interface LinkAccountInput {
  userId: string;
  provider: MergeProvider;
  /** Self-managed GitLab base URL; null for every other account (an Azure DevOps account has no host). */
  host: string | null;
  user: OAuthUser;
  credentials: MergeStoredCredentials;
}

export type LinkAccountResult = { ok: true; account: MergeProviderAccountRow } | { ok: false; reason: 'login_taken' };

const sameHost = (host: string | null) => (host ? eq(mergeProviderAccounts.host, host) : isNull(mergeProviderAccounts.host));

/** Pull requests the login authored belong to the member; ones an older login claimed are released. */
export async function claimAuthoredPullRequests(db: Db, userId: string, provider: MergeProvider, login: string): Promise<void> {
  await db
    .update(mergePullRequests)
    .set({ authorUserId: null })
    .where(
      and(
        eq(mergePullRequests.authorUserId, userId),
        eq(mergePullRequests.provider, provider),
        ne(mergePullRequests.authorLogin, login),
      ),
    );
  await db
    .update(mergePullRequests)
    .set({ authorUserId: userId })
    .where(
      and(eq(mergePullRequests.provider, provider), eq(mergePullRequests.authorLogin, login), isNull(mergePullRequests.authorUserId)),
    );
}

/** Links (or re-links) the member's account; 409 `login_taken` when another member holds that login on the provider. */
export async function linkProviderAccount(db: Db, env: Env, input: LinkAccountInput): Promise<LinkAccountResult> {
  const login = input.user.login.toLowerCase();
  const [holder] = await db
    .select({ userId: mergeProviderAccounts.userId })
    .from(mergeProviderAccounts)
    .where(and(eq(mergeProviderAccounts.provider, input.provider), sameHost(input.host), eq(mergeProviderAccounts.login, login)))
    .limit(1);
  if (holder && holder.userId !== input.userId) return { ok: false, reason: 'login_taken' };

  const now = new Date();
  const fields = {
    login,
    externalUserId: input.user.externalId,
    host: input.host,
    credentials: await sealCredentials(env, input.credentials),
    credentialsExpireAt: input.credentials.expiresAt ? new Date(input.credentials.expiresAt) : null,
    verifiedAt: now,
    avatarUrl: input.user.avatarUrl,
    displayName: input.user.displayName,
    updatedAt: now,
  };

  const [mine] = await db
    .select()
    .from(mergeProviderAccounts)
    .where(and(eq(mergeProviderAccounts.userId, input.userId), eq(mergeProviderAccounts.provider, input.provider), sameHost(input.host)))
    .limit(1);
  try {
    const [account] = mine
      ? await db.update(mergeProviderAccounts).set(fields).where(eq(mergeProviderAccounts.id, mine.id)).returning()
      : await db
          .insert(mergeProviderAccounts)
          .values({ id: generateId('mpa'), userId: input.userId, provider: input.provider, createdAt: now, ...fields })
          .returning();
    await claimAuthoredPullRequests(db, input.userId, input.provider, login);
    return { ok: true, account: account! };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'login_taken' };
    throw err;
  }
}

/** Removes the member's account for a provider (and host); false when there was none. Their authored pull requests are released. */
export async function unlinkProviderAccount(db: Db, userId: string, provider: MergeProvider, host: string | null): Promise<boolean> {
  const removed = await db
    .delete(mergeProviderAccounts)
    .where(and(eq(mergeProviderAccounts.userId, userId), eq(mergeProviderAccounts.provider, provider), sameHost(host)))
    .returning({ id: mergeProviderAccounts.id });
  if (removed.length === 0) return false;
  await db
    .update(mergePullRequests)
    .set({ authorUserId: null })
    .where(and(eq(mergePullRequests.authorUserId, userId), eq(mergePullRequests.provider, provider)));
  return true;
}
