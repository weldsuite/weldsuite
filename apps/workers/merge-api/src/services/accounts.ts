/** A member's own login on a git provider: "needs your review" and "yours" match on it. */

import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { MergeProviderAccountsDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import { mergeProviderAccounts, mergePullRequests, type Db } from './db';
import { providerAccountDto } from './mappers';

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

export type SetLoginResult = { ok: true; login: string | null } | { ok: false; reason: 'login_taken' };

/**
 * Saves (or, with an empty login, removes) the member's GitHub login, stored
 * lower-case. The pull requests that login authored are matched to the member.
 */
export async function setGithubLogin(db: Db, userId: string, raw: string | null | undefined): Promise<SetLoginResult> {
  const login = raw?.trim().toLowerCase() || null;

  if (!login) {
    await db
      .delete(mergeProviderAccounts)
      .where(and(eq(mergeProviderAccounts.userId, userId), eq(mergeProviderAccounts.provider, 'github')));
    await db.update(mergePullRequests).set({ authorUserId: null }).where(eq(mergePullRequests.authorUserId, userId));
    return { ok: true, login: null };
  }

  const [holder] = await db
    .select({ userId: mergeProviderAccounts.userId })
    .from(mergeProviderAccounts)
    .where(and(eq(mergeProviderAccounts.provider, 'github'), eq(mergeProviderAccounts.login, login)))
    .limit(1);
  if (holder && holder.userId !== userId) return { ok: false, reason: 'login_taken' };

  const now = new Date();
  const [mine] = await db
    .select({ id: mergeProviderAccounts.id })
    .from(mergeProviderAccounts)
    .where(and(eq(mergeProviderAccounts.userId, userId), eq(mergeProviderAccounts.provider, 'github')))
    .limit(1);
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

  // Pull requests the member no longer owns (an old login), then the ones the new login authored.
  await db
    .update(mergePullRequests)
    .set({ authorUserId: null })
    .where(and(eq(mergePullRequests.authorUserId, userId), ne(mergePullRequests.authorLogin, login)));
  await db
    .update(mergePullRequests)
    .set({ authorUserId: userId })
    .where(and(eq(mergePullRequests.authorLogin, login), isNull(mergePullRequests.authorUserId)));
  return { ok: true, login };
}
