/**
 * The request context of the account services (domains, mailboxes): who is
 * asking, which workspace, and the limits staff approved. The access summary
 * itself (`GET /api/reach/access`, usage counts) is in
 * `@weldsuite/reach-domain/access`.
 */

import type { Context } from 'hono';
import { getMasterDb, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { resolveWeldReachLimits, type WeldReachLimits } from '@weldsuite/app-api-client/schemas/reach';
import type { Env, Variables } from '../types';
import { ReachServiceError } from './reach-errors';

/** Who is asking and what they may use, as the account services need it. */
export interface ReachAccountContext {
  db: Database;
  master: MasterDatabase;
  /** Clerk org id (`c.get('clerkOrgId')`): the key of the stores still keyed by it (R2, due index, pool rows). */
  clerkOrgId: string;
  /** Master `workspaces.id`, the owner of `reach_routes` rows. */
  masterWorkspaceId: string;
  userId: string;
  /** Staff-set limits from the approval. */
  limits: WeldReachLimits;
}

/** The services' context from a request that passed `appAccessGate('weldreach')`. */
export function accountContextOf(c: Context<{ Bindings: Env; Variables: Variables }>): ReachAccountContext {
  const access = c.get('appAccess');
  if (!access.workspaceId) {
    throw new ReachServiceError(403, 'WORKSPACE_NOT_FOUND', 'This workspace is not set up for WeldReach.');
  }
  return {
    db: c.get('tenantDb'),
    master: getMasterDb(c.env),
    clerkOrgId: c.get('clerkOrgId'),
    masterWorkspaceId: access.workspaceId,
    userId: c.get('userId'),
    limits: resolveWeldReachLimits(access.limits),
  };
}
