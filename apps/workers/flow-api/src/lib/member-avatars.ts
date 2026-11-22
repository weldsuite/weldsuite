/**
 * Avatars of the people a response names. A person's avatar is their account
 * picture (`users.image_url` in the master database, see
 * `@weldsuite/worker-kit/account-pictures`), never `workspace_members.picture`,
 * so routes join `workspace_members` for the name and email only and add the
 * picture here, in one lookup per response.
 */

import { accountPicture, loadAccountPictures, type AccountPictureEnv } from '@weldsuite/worker-kit/account-pictures';

/** A `workspace_members` left join projected as `user: { id, … }` (null when no member row matched). */
type JoinedUser = { id: string | null };

/** Set `user.avatar` on each row to the account picture of `user.id`; `user: null` stays null. */
export async function withUserAvatars<U extends JoinedUser, T extends { user: U | null }>(
  env: AccountPictureEnv,
  rows: readonly T[],
): Promise<Array<Omit<T, 'user'> & { user: (U & { avatar: string | null }) | null }>> {
  const pictures = await loadAccountPictures(env, rows.map((row) => row.user?.id));
  return rows.map((row) => ({
    ...row,
    user: row.user ? { ...row.user, avatar: accountPicture(pictures, row.user.id) } : null,
  }));
}
