/**
 * Permission checks for entity channel access outside a request's own user.
 *
 * Route handlers check the caller with `hasContextPermission` (resolved once
 * per request, app-aware). Some paths must ask about someone else, such as a
 * user who was @mentioned in a record chat: whether they may follow it depends
 * on their own grants. Those resolve the user's permissions from the tenant DB,
 * exactly as `requirePermission` does, and evaluate them across all apps with
 * member denies applied.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { hasAppPermission } from '@weldsuite/permissions';
import { createDrizzlePermissionQueries, resolveEffectivePermissions } from '@weldsuite/permissions/server';
import type { ResolvedPermissions } from '@weldsuite/permissions/types';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { PermissionCheck } from './registry';

/** A permission check for `userId`, resolved lazily from the tenant DB on first use. */
export function userPermissionCheck(db: Database, userId: string): PermissionCheck {
  let resolved: Promise<ResolvedPermissions> | null = null;
  return async (permission) => {
    resolved ??= resolveEffectivePermissions(
      createDrizzlePermissionQueries(db, schema, { eq, and, isNull }),
      userId,
    );
    return hasAppPermission(await resolved, permission, null);
  };
}
