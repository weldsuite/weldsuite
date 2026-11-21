/**
 * A person's avatar is their account picture: `users.image_url` in the master
 * database. The identity provider sets it when the account is created (Clerk
 * generates one when the person has no photo) and the `user.updated` webhook
 * keeps it current, so it is the same in every workspace the person is in.
 *
 * `workspace_members.picture` is not an avatar source: it was a per-workspace
 * copy that drifted from the account (empty for members added before the copy
 * was filled, stale after a photo change). Every API that returns a person's
 * picture resolves it here instead, by user id.
 *
 * The lookup is one `select … where id in (…)` on the master database per
 * call, so batch: collect the user ids of a whole response, then resolve them
 * together. A failed lookup is logged and answers "no picture" (the clients
 * draw initials) rather than failing the response it decorates.
 */

import { inArray } from 'drizzle-orm';
import { users } from '@weldsuite/db/schema/master';
import { getMasterDb } from './db';
import type { DbEnv } from './env';

export type AccountPictureEnv = Pick<DbEnv, 'DATABASE_URL_MASTER'>;

/** User id → account picture URL (null when the account has none). */
export type AccountPictures = ReadonlyMap<string, string | null>;

const EMPTY: AccountPictures = new Map();

/** Account pictures of the given users. Ids without an account are absent from the map. */
export async function loadAccountPictures(
  env: AccountPictureEnv,
  userIds: Iterable<string | null | undefined>,
): Promise<AccountPictures> {
  const ids = [...new Set([...userIds].filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return EMPTY;
  try {
    const rows = await getMasterDb(env)
      .select({ id: users.id, imageUrl: users.imageUrl })
      .from(users)
      .where(inArray(users.id, ids));
    return new Map(rows.map((row) => [row.id, row.imageUrl || null]));
  } catch (err) {
    console.warn('[worker-kit/account-pictures] lookup failed:', err instanceof Error ? err.message : err);
    return EMPTY;
  }
}

/** The account picture of one user, or null. */
export async function loadAccountPicture(
  env: AccountPictureEnv,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  return (await loadAccountPictures(env, [userId])).get(userId) ?? null;
}

/** Read one user's picture out of a loaded map (null when unknown or absent). */
export function accountPicture(pictures: AccountPictures, userId: string | null | undefined): string | null {
  return userId ? pictures.get(userId) ?? null : null;
}

/**
 * Replace `picture` on each row with its `userId`'s account picture. Rows keep
 * every other field; a row without a user id (an invite placeholder, an agent)
 * gets `picture: null`.
 */
export async function withAccountPictures<T extends { userId?: string | null }>(
  env: AccountPictureEnv,
  rows: readonly T[],
): Promise<Array<T & { picture: string | null }>> {
  const pictures = await loadAccountPictures(env, rows.map((row) => row.userId));
  return rows.map((row) => ({ ...row, picture: accountPicture(pictures, row.userId) }));
}
