/** A member's own login on a git provider: "needs your review" and "yours" match on it. */

import { and, asc, eq } from 'drizzle-orm';
import type { MergeProviderAccountsDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import { mergeProviderAccounts, mergePullRequests, type Db } from './db';
import { providerAccountDto } from './mappers';
import { claimAuthoredPullRequests } from './oauth/accounts';

/** Every account the member has linked (typed logins and OAuth links), without credentials. */
export async function listAccounts(db: Db, userId: string): Promise<MergeProviderAccountsDto> {
  const rows = await db
    .select()
    .from(mergeProviderAccounts)
    .where(eq(mergeProviderAccounts.userId, userId))
    .orderBy(asc(mergeProviderAccounts.provider), asc(mergeProviderAccounts.createdAt));
  const github = rows.find((r) => r.provider === 'github' && !r.host);
  return { github: github?.login ?? null, accounts: rows.map(providerAccountDto) };
}

export async function getGithubLogin(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ login: mergeProviderAccounts.login })
    .from(mergeProviderAccounts)
    .where(and(eq(mergeProviderAccounts.userId, userId), eq(mergeProviderAccounts.provider, 'github')))
    .limit(1);
  return row?.login ?? null;
}

export type SetLoginResult = { ok: true; login: string | null } | { ok: false; reason: 'login_taken' | 'account_verified' };

/**
 * Saves (or, with an empty login, removes) the member's GitHub login, stored
 * lower-case. The GitHub pull requests that login authored are matched to the
 * member. A login GitHub vouched for (an OAuth link, `verifiedAt` set) is not
 * overwritten by a typed one: a different login is refused with
 * `account_verified`, so the member unlinks first and the link's token never
 * outlives its login. Removing it (an empty login) drops the link with it.
 */
export async function setGithubLogin(db: Db, userId: string, raw: string | null | undefined): Promise<SetLoginResult> {
  const login = raw?.trim().toLowerCase() || null;

  if (!login) {
    await db
      .delete(mergeProviderAccounts)
      .where(and(eq(mergeProviderAccounts.userId, userId), eq(mergeProviderAccounts.provider, 'github')));
    await db
      .update(mergePullRequests)
      .set({ authorUserId: null })
      .where(and(eq(mergePullRequests.authorUserId, userId), eq(mergePullRequests.provider, 'github')));
    return { ok: true, login: null };
  }

  const [mine] = await db
    .select({ id: mergeProviderAccounts.id, login: mergeProviderAccounts.login, verifiedAt: mergeProviderAccounts.verifiedAt })
    .from(mergeProviderAccounts)
    .where(and(eq(mergeProviderAccounts.userId, userId), eq(mergeProviderAccounts.provider, 'github')))
    .limit(1);
  if (mine?.verifiedAt && mine.login !== login) return { ok: false, reason: 'account_verified' };

  const [holder] = await db
    .select({ userId: mergeProviderAccounts.userId })
    .from(mergeProviderAccounts)
    .where(and(eq(mergeProviderAccounts.provider, 'github'), eq(mergeProviderAccounts.login, login)))
    .limit(1);
  if (holder && holder.userId !== userId) return { ok: false, reason: 'login_taken' };

  const now = new Date();
  try {
    if (mine) {
      await db.update(mergeProviderAccounts).set({ login, updatedAt: now }).where(eq(mergeProviderAccounts.id, mine.id));
    } else {
      await db
        .insert(mergeProviderAccounts)
        .values({ id: generateId('mpa'), userId, provider: 'github', login, createdAt: now, updatedAt: now });
    }
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'login_taken' };
    throw err;
  }

  // GitHub pull requests the member no longer owns (an old login), then the ones the new login authored.
  await claimAuthoredPullRequests(db, userId, 'github', login);
  return { ok: true, login };
}
