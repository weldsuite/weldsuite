/**
 * Who the query cache currently belongs to. `userId` is `undefined` until the
 * first identity is seen (app start), `null` while signed out.
 */
export interface CacheOwner {
  userId: string | null | undefined;
  orgId: string | null;
}

export type CacheAction = 'clear' | 'reset' | null;

export const INITIAL_CACHE_OWNER: CacheOwner = { userId: undefined, orgId: null };

/**
 * What to do with the query cache when the signed-in user or workspace changes.
 *
 * The cache's keys are not per user or per workspace, so a new user gets an
 * empty cache (`clear`: sign-out, an expired session, another person) and a
 * new workspace for the same user reloads what is on screen (`reset`).
 * Picking the first workspace right after sign-in is not a switch: the cache
 * was already cleared when the previous user left.
 */
export function cacheActionFor(previous: CacheOwner, next: CacheOwner): CacheAction {
  if (previous.userId !== undefined && previous.userId !== next.userId) return 'clear';
  if (previous.orgId && next.orgId && previous.orgId !== next.orgId) return 'reset';
  return null;
}
