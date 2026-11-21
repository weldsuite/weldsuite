/**
 * Teammates' avatars for the widget: their account pictures, `users.image_url`
 * in the master database, never `workspace_members.picture` (see
 * `@weldsuite/worker-kit/account-pictures`). This worker reaches the master
 * database through its own client (Hyperdrive, or `DATABASE_URL_MASTER`), so it
 * looks them up here with the same rules: one query per call, and a failed
 * lookup answers "no pictures" rather than failing the response.
 */

import { inArray } from 'drizzle-orm';
import { users } from '@weldsuite/db/schema/master';
import type { AccountPictures } from '@weldsuite/worker-kit/account-pictures';
import { getMasterDb } from '../db';
import type { Env } from '../index';

export { accountPicture, type AccountPictures } from '@weldsuite/worker-kit/account-pictures';

const EMPTY: AccountPictures = new Map();

/** User id → account picture URL (null when the account has none). */
export async function loadAccountPictures(
  env: Env,
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
    console.warn('[widget-api] account picture lookup failed:', err instanceof Error ? err.message : err);
    return EMPTY;
  }
}
