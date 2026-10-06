/**
 * Run-time permission check for WeldConnect actions.
 *
 * A workflow acts on behalf of its owner (`workflows.created_by`): every
 * WeldSuite action a run performs is checked against the owner's workspace
 * permissions as they are NOW, not when the workflow was built. A member who
 * loses a permission, or leaves the workspace, stops their workflows from
 * doing what they no longer may.
 *
 * Same rules as the `requirePermission` middleware: denies win, and an
 * app-scoped key refused in its app but granted in another app is allowed
 * unless app enforcement is on (`PERMISSIONS_APP_ENFORCE`), so a run can't be
 * stricter than the owner's own requests.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { checkAppPermission } from '@weldsuite/permissions';
import { createDrizzlePermissionQueries, resolveEffectivePermissions } from '@weldsuite/permissions/server';

/** The owner may not do this (or is no longer a member); the step fails without retrying. */
export class WorkflowOwnerForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowOwnerForbiddenError';
  }
}

export interface OwnerCheck {
  /** Permission key, e.g. `people:create`. */
  permission: string;
  /** App the action belongs to (`weldcrm`, `weldflow`, …). */
  app: string;
  /** What the action does, for the error message ("create contacts"). */
  doing: string;
}

/**
 * Throws `WorkflowOwnerForbiddenError` unless the owner may perform the
 * action. Returns the owner's resolved permissions, for follow-up scope checks.
 */
export async function authorizeWorkflowOwner(
  db: Database,
  env: { PERMISSIONS_APP_ENFORCE?: string },
  ownerUserId: string,
  check: OwnerCheck,
) {
  const queries = createDrizzlePermissionQueries(db, schema, { eq, and, isNull });
  const resolved = await resolveEffectivePermissions(queries, ownerUserId);
  if (!resolved.role) {
    throw new WorkflowOwnerForbiddenError(
      "The workflow's owner is no longer a member of this workspace, so it can't act for them",
    );
  }

  const inApp = checkAppPermission(resolved, check.permission, check.app);
  const elsewhere = inApp.mode === 'app' && checkAppPermission(resolved, check.permission, null).allowed;
  const allowed = inApp.allowed || (elsewhere && env.PERMISSIONS_APP_ENFORCE !== 'true');
  if (!allowed) {
    throw new WorkflowOwnerForbiddenError(
      `The workflow's owner doesn't have permission to ${check.doing} (${check.permission})`,
    );
  }
  return resolved;
}

/** True when the owner holds the given key (used for `<object>:scope:all` checks). */
export function ownerHolds(
  resolved: Awaited<ReturnType<typeof authorizeWorkflowOwner>>,
  permission: string,
  app: string,
): boolean {
  return checkAppPermission(resolved, permission, app).allowed;
}
