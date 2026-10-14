/**
 * Tenant and access lookups for code that runs outside a request (cron, the
 * send queue consumer, the email() handler, the Mailpool webhook). Request
 * handlers use `c.get('tenantDb')` and `c.get('appAccess')` instead.
 */

import { readAppAccess, type AppAccess } from '@weldsuite/worker-kit/app-access';
import { getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit';
import { WELDREACH_APP_CODE, resolveWeldReachLimits, type WeldReachLimits } from '@weldsuite/app-api-client/schemas/reach';
import type { Env } from '../types';

export async function openTenantDb(env: Env, clerkOrgId: string): Promise<Database> {
  return getTenantDbForWorkspace(env, clerkOrgId);
}

/** Uncached master read: background work must see a suspension at once. */
export async function readReachAccess(env: Env, clerkOrgId: string): Promise<AppAccess> {
  return readAppAccess(env, clerkOrgId, WELDREACH_APP_CODE);
}

export function reachLimits(access: Pick<AppAccess, 'limits'>): WeldReachLimits {
  return resolveWeldReachLimits(access.limits);
}
