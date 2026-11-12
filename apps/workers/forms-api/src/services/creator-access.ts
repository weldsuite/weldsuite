/**
 * Integrations act as the member who set them up (ADR FORMS-006, as WeldConnect
 * runs as its owner, CONN-004): each step checks the creator's workspace
 * permissions as they are NOW. A creator who lost a permission, or left the
 * workspace, makes the step skip with the reason shown on the integration
 * instead of writing records they could not create themselves.
 *
 * Same rules as `requirePermission`: denies win, and a key refused in its app
 * but granted elsewhere is allowed unless app enforcement is on
 * (`PERMISSIONS_APP_ENFORCE`).
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { checkAppPermission } from '@weldsuite/permissions';
import { createDrizzlePermissionQueries, resolveEffectivePermissions } from '@weldsuite/permissions/server';

/** The creator may not do this (or is no longer a member): the step is skipped, not retried. */
export class CreatorForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreatorForbiddenError';
  }
}

export interface CreatorAccess {
  /** Whether the creator holds `permission` in `app` right now. */
  can(permission: string, app: string): boolean;
  /** Throws `CreatorForbiddenError` unless they hold it; `doing` completes "doesn't have permission to …". */
  require(permission: string, app: string, doing: string): void;
}

export async function loadCreatorAccess(db: Database, env: { PERMISSIONS_APP_ENFORCE?: string }, userId: string): Promise<CreatorAccess> {
  const resolved = await resolveEffectivePermissions(createDrizzlePermissionQueries(db, schema, { eq, and, isNull }), userId);
  const member = Boolean(resolved.role);
  const can = (permission: string, app: string): boolean => {
    if (!member) return false;
    const inApp = checkAppPermission(resolved, permission, app);
    const elsewhere = inApp.mode === 'app' && checkAppPermission(resolved, permission, null).allowed;
    return inApp.allowed || (elsewhere && env.PERMISSIONS_APP_ENFORCE !== 'true');
  };
  return {
    can,
    require(permission, app, doing) {
      if (!member) throw new CreatorForbiddenError('The member who set up this integration is no longer in the workspace');
      if (!can(permission, app)) {
        throw new CreatorForbiddenError(`The member who set up this integration is not allowed to ${doing} (${permission})`);
      }
    },
  };
}
