/**
 * Resolves the tenant database for the authenticated org and injects it
 * into the Hono context. Trimmed clone of core-api's middleware — no
 * member-reconciliation or role-seeding here; those background tasks are
 * core-api's responsibility and would duplicate work if mirrored.
 */

import { createMiddleware } from 'hono/factory';
import { getWorkspaceContextForOrg, type Database } from '../db';
import type { Env } from '../types';

type WorkspaceDbVariables = {
  userId: string;
  orgId: string | null;
  sessionId: string;
  tenantDb: Database;
  workspaceId: string;
};

export const workspaceDbMiddleware = () => {
  return createMiddleware<{
    Bindings: Env;
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

    const { db, suspended } = await getWorkspaceContextForOrg(c.env, orgId);

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
    c.set('workspaceId', orgId);

    await next();
  });
};
