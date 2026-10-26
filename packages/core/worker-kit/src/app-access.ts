/**
 * Access to apps that are on request only (`app_catalog.requires_approval`).
 *
 * A workspace asks for access from the app store, WeldSuite staff approve it
 * in the admin console (master `workspace_app_access`), and the module worker
 * refuses every request until then. `appAccessGate(appCode)` runs after
 * `apiAuth()` and answers 403 APP_ACCESS_REQUIRED with the current status, so
 * the platform can show "pending", "rejected" or "suspended" instead of a
 * broken screen.
 *
 * The status is cached in KV for 60 s (`appaccess:<org>:<app>`): a suspension
 * reaches the request path within a minute without a master-DB read per
 * request. Background work that must stop immediately (WeldReach's send
 * consumer) reads the master DB with `readAppAccess` instead.
 *
 * Workers without `DATABASE_URL_MASTER` (external-api reaches master through a
 * Hyperdrive binding) call the `...From` variants with their own master handle.
 */

import { and, eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { getMasterDb, masterSchema, type AnyMasterDatabase } from './db';
import type { DbEnv } from './env';
import { matchWorkspaceRef } from '@weldsuite/db/lib/workspace-ref';

export type AppAccessStatus = 'none' | 'requested' | 'approved' | 'rejected' | 'suspended' | 'revoked';

export interface AppAccess {
  /** Master `workspaces.id`, or null when the org has no workspace row. */
  workspaceId: string | null;
  status: AppAccessStatus;
  limits: Record<string, unknown>;
  /** The app's own Stripe subscription state (billing-worker keeps it current). */
  billingStatus: 'none' | 'active' | 'past_due' | 'canceled';
  /** When billingStatus last changed (ISO), for grace periods. */
  billingStatusAt: string | null;
}

export const APP_ACCESS_CACHE_TTL_SECONDS = 60;

export function appAccessCacheKey(clerkOrgId: string, appCode: string): string {
  return `appaccess:${clerkOrgId}:${appCode}`;
}

/** Uncached read on a master-DB handle of any driver. */
export async function readAppAccessFrom(
  master: AnyMasterDatabase,
  clerkOrgId: string,
  appCode: string,
): Promise<AppAccess> {
  const [row] = await master
    .select({
      workspaceId: masterSchema.workspaces.id,
      status: masterSchema.workspaceAppAccess.status,
      limits: masterSchema.workspaceAppAccess.limits,
      billingStatus: masterSchema.workspaceAppAccess.billingStatus,
      billingStatusAt: masterSchema.workspaceAppAccess.billingStatusAt,
    })
    .from(masterSchema.workspaces)
    .leftJoin(
      masterSchema.workspaceAppAccess,
      and(
        eq(masterSchema.workspaceAppAccess.workspaceId, masterSchema.workspaces.id),
        eq(masterSchema.workspaceAppAccess.appCode, appCode),
      ),
    )
    .where(matchWorkspaceRef(clerkOrgId))
    .limit(1);

  return {
    workspaceId: row?.workspaceId ?? null,
    status: row?.status ?? 'none',
    limits: row?.limits ?? {},
    billingStatus: row?.billingStatus ?? 'none',
    billingStatusAt: row?.billingStatusAt ? row.billingStatusAt.toISOString() : null,
  };
}

/** Uncached master-DB read. */
export async function readAppAccess(
  env: Pick<DbEnv, 'DATABASE_URL_MASTER'>,
  clerkOrgId: string,
  appCode: string,
): Promise<AppAccess> {
  return readAppAccessFrom(getMasterDb(env), clerkOrgId, appCode);
}

/** Where a cached read looks: the shared KV namespace, and a master handle opened only on a miss. */
export interface AppAccessSource {
  /** `WORKSPACE_CACHE`: every API worker shares the namespace, so one worker's read serves the others. */
  cache: Pick<KVNamespace, 'get' | 'put'>;
  master: () => AnyMasterDatabase;
}

/** KV-cached (60 s) read on a master-DB handle of any driver. */
export async function getAppAccessFrom(source: AppAccessSource, clerkOrgId: string, appCode: string): Promise<AppAccess> {
  const key = appAccessCacheKey(clerkOrgId, appCode);
  try {
    const cached = (await source.cache.get(key, 'json')) as AppAccess | null;
    if (cached) return cached;
  } catch (err) {
    console.warn('[app-access] KV read failed:', err);
  }
  const access = await readAppAccessFrom(source.master(), clerkOrgId, appCode);
  try {
    await source.cache.put(key, JSON.stringify(access), { expirationTtl: APP_ACCESS_CACHE_TTL_SECONDS });
  } catch (err) {
    console.warn('[app-access] KV write failed:', err);
  }
  return access;
}

/** KV-cached (60 s) read for the request path. */
export async function getAppAccess(env: DbEnv, clerkOrgId: string, appCode: string): Promise<AppAccess> {
  return getAppAccessFrom({ cache: env.WORKSPACE_CACHE, master: () => getMasterDb(env) }, clerkOrgId, appCode);
}

export function appAccessRequiredBody(appCode: string, status: AppAccessStatus) {
  return {
    error: {
      code: 'APP_ACCESS_REQUIRED',
      message: `This workspace has no approved access to ${appCode}.`,
      details: { appCode, status },
    },
  };
}

type AppAccessGateVariables = {
  orgId: string | null;
  appAccess: AppAccess;
};

/**
 * Refuse every request unless the workspace's access to `appCode` is approved.
 * Runs after `apiAuth()` (needs `orgId`). Sets `c.get('appAccess')` with the
 * staff-set limits for the routes to enforce.
 */
export const appAccessGate = (appCode: string) => {
  return createMiddleware<{ Bindings: DbEnv; Variables: AppAccessGateVariables }>(async (c, next) => {
    const orgId = c.get('orgId');
    if (!orgId) return c.json(appAccessRequiredBody(appCode, 'none'), 403);
    const access = await getAppAccess(c.env, orgId, appCode);
    if (access.status !== 'approved') return c.json(appAccessRequiredBody(appCode, access.status), 403);
    c.set('appAccess', access);
    await next();
  });
};
