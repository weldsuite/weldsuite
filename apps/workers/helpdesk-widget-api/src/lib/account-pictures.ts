/**
 * Teammates' avatars for the widget: their account pictures, `users.image_url`
 * in the master database, never `workspace_members.picture` (ADR SEC-020). The
 * rules are worker-kit's (`@weldsuite/worker-kit/account-pictures`); this
 * worker only opens the master database its own way (Hyperdrive, or
 * `DATABASE_URL_MASTER`).
 */

import {
  tryLoadAccountPicturesFrom,
  type AccountPictures,
} from '@weldsuite/worker-kit/account-pictures';
import { getMasterDb } from '../db';
import type { Env } from '../index';

export { accountPicture, type AccountPictures } from '@weldsuite/worker-kit/account-pictures';

/** User id → account picture URL; a failed lookup answers no pictures. */
export async function loadAccountPictures(
  env: Env,
  userIds: Iterable<string | null | undefined>,
): Promise<AccountPictures> {
  return (await tryLoadAccountPicturesFrom(() => getMasterDb(env), userIds)) ?? new Map();
}
