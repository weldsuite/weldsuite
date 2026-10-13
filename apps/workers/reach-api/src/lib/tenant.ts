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

/** Days a past-due WeldReach subscription keeps sending before campaigns pause. */
export const BILLING_GRACE_DAYS = 7;

/** Whether background sending may run for this workspace right now. */
export function maySend(access: AppAccess, now = new Date()): { ok: true } | { ok: false; reason: string } {
  if (access.status !== 'approved') return { ok: false, reason: `access_${access.status}` };
  if (access.billingStatus === 'canceled') return { ok: false, reason: 'billing_canceled' };
  if (access.billingStatus === 'past_due') {
    const since = access.billingStatusAt ? new Date(access.billingStatusAt).getTime() : now.getTime();
    if (now.getTime() - since > BILLING_GRACE_DAYS * 86_400_000) return { ok: false, reason: 'billing_past_due' };
  }
  return { ok: true };
}
