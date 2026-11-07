/**
 * Who an internal call acts as. WeldConnect actions and WeldAgent tools reach
 * merge-api over the `MergeInternal` entrypoint, which has no Clerk session:
 * the caller names a member (the workflow's owner, the agent's acting member)
 * and every call is checked against that member's permissions as they are NOW
 * (CONN-004), the same resolution `requirePermission` and connect-api's
 * `authorizeWorkflowOwner` use. A member who loses a permission, or leaves the
 * workspace, stops their workflows and agents from doing what they no longer may.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getWorkspaceContextForOrg, schema, type Database } from '@weldsuite/worker-kit/db';
import { checkAppPermission } from '@weldsuite/permissions';
import { createDrizzlePermissionQueries, resolveEffectivePermissions } from '@weldsuite/permissions/server';
import type { Env } from '../types';
import type { Ctx } from '../routes/shared';
import type { AgentAssigner } from './issues';

/** The member may not do this (or is no longer a member of the workspace). */
export class MemberForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message: string) {
    super(message);
    this.name = 'MemberForbiddenError';
  }
}

export const MERGE_APP = 'weldmerge';

/** Throws unless the member holds `permission` (in WeldMerge, or workspace-wide unless app enforcement is on). */
export async function authorizeMember(
  db: Database,
  env: Pick<Env, 'PERMISSIONS_APP_ENFORCE'>,
  userId: string,
  permission: string,
  doing: string,
): Promise<void> {
  const queries = createDrizzlePermissionQueries(db, schema, { eq, and, isNull });
  const resolved = await resolveEffectivePermissions(queries, userId);
  if (!resolved.role) {
    throw new MemberForbiddenError('The member this call acts for is no longer a member of this workspace');
  }
  const inApp = checkAppPermission(resolved, permission, MERGE_APP);
  const elsewhere = inApp.mode === 'app' && checkAppPermission(resolved, permission, null).allowed;
  const allowed = inApp.allowed || (elsewhere && env.PERMISSIONS_APP_ENFORCE !== 'true');
  if (!allowed) {
    throw new MemberForbiddenError(`The member this call acts for may not ${doing} (${permission})`);
  }
}

/**
 * The member an internal call acts for, as an agent assigner (`updateIssueAs`
 * with an `agentId`): `weldagent:use` and `weldagent:manage` as their
 * permissions are now, in any app. A former member can use no agent.
 */
export async function memberAgentAssigner(db: Database, userId: string): Promise<AgentAssigner> {
  const queries = createDrizzlePermissionQueries(db, schema, { eq, and, isNull });
  const resolved = await resolveEffectivePermissions(queries, userId);
  const holds = (permission: string) => Boolean(resolved.role) && checkAppPermission(resolved, permission, null).allowed;
  return { userId, canUse: holds('weldagent:use'), canManageAll: holds('weldagent:manage') };
}

/**
 * The tenant DB for an internal call. The entrypoint has no auth middleware, so
 * the workspace is resolved here by either of its ids (a test app has it set
 * already). Null when the workspace does not exist or is suspended; the caller
 * is `acting` for `userId`, who becomes the request's user (events, hooks).
 */
export async function resolveInternalWorkspace(c: Ctx, workspaceId: string, userId: string): Promise<Database | null> {
  let db = c.get('tenantDb') as Database | undefined;
  if (!db) {
    try {
      const workspace = await getWorkspaceContextForOrg(c.env, workspaceId);
      if (workspace.suspended) return null;
      db = workspace.db;
      c.set('tenantDb', db);
      c.set('workspaceId', workspace.id);
      c.set('clerkOrgId', workspace.clerkOrgId ?? workspaceId);
    } catch {
      return null;
    }
  }
  c.set('userId', userId);
  return db;
}
