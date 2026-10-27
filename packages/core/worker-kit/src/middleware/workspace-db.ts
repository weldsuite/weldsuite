/**
 * Resolves the tenant database for the authenticated org and injects it
 * into the Hono context. Rejects requests without an active org (403
 * ORG_REQUIRED) and suspended workspaces (403 WORKSPACE_SUSPENDED). Also sets
 * the workspace licence (`licensedApps`) and read-only state (`readOnly`,
 * `readOnlyReason`, including `database_move` while the workspace's database is
 * being moved) that `licenceGate()` checks.
 *
 * `workspaceId` is `workspaces.id`. `clerkOrgId` is the workspace's Clerk org id
 * (the session token's org), for Clerk calls and for the stores still keyed by
 * it until they move (docs/plans/workspace-id-standardization.md, ADR SEC-011).
 */

import { createMiddleware } from 'hono/factory';
import { getWorkspaceContextForOrg } from '../db';
import type { Database, KitEnv } from '../env';
import type { ReadOnlyReason } from '../read-only';

type WorkspaceDbVariables = {
  userId: string;
  orgId: string | null;
  sessionId: string;
  tenantDb: Database;
  workspaceId: string;
  clerkOrgId: string;
  licensedApps: readonly string[] | null;
  readOnly: boolean;
  readOnlyReason: ReadOnlyReason | null;
};

export const workspaceDbMiddleware = () => {
  return createMiddleware<{
    Bindings: KitEnv;
    Variables: WorkspaceDbVariables;
  }>(async (c, next) => {
    const orgId = c.get('orgId');

    if (!orgId) {
      return c.json(
        {
          error: {
            code: 'ORG_REQUIRED',
            message: 'This endpoint requires an active organization.',
          },
        },
        403,
      );
    }

    const { id, db, suspended, licensedApps, readOnly, readOnlyReason } = await getWorkspaceContextForOrg(c.env, orgId);

    // A suspended workspace (isActive=false) has been scheduled for deletion by
    // an admin. Reject all tenant access until it is either restored (cancelled)
    // or permanently deleted. Propagation is bounded by the workspace KV TTL.
    if (suspended) {
      return c.json(
        {
          error: {
            code: 'WORKSPACE_SUSPENDED',
            message: 'This workspace has been suspended and is scheduled for deletion.',
          },
        },
        403,
      );
    }

    c.set('tenantDb', db);
    c.set('workspaceId', id);
    c.set('clerkOrgId', orgId);
    c.set('licensedApps', licensedApps);
    c.set('readOnly', readOnly);
    c.set('readOnlyReason', readOnlyReason);

    await next();
  });
};
