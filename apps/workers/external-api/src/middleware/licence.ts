/**
 * App licence and read-only checks for the public API. A partner-managed
 * workspace (docs/plans/reseller-licensing.md) carries a licence listing the
 * apps it may use; a call into a module none of them reads is rejected with
 * 403 APP_NOT_LICENSED. Uses the same module table as the first-party workers'
 * `licenceGate()` (`@weldsuite/api-modules`), mapping `/v1/<object>` onto its
 * module.
 *
 * A read-only workspace (partner suspended or licence inactive) may only read:
 * every other request is refused with 403 WORKSPACE_READ_ONLY.
 *
 * A workspace whose tenant database is being moved (`readOnlyReason`
 * `database_move`, TASK-1150) gets the same exceptions but a different refusal:
 * a write is answered with 503 WORKSPACE_MOVING and `Retry-After`, so clients
 * retry.
 *
 * Runs after authMiddleware, which puts `licensedApps` and `readOnly` on the
 * session.
 */

import type { MiddlewareHandler } from 'hono';
import { appNotLicensedBody, findModuleForExternalPath, missingLicensedApp } from '@weldsuite/api-modules';
import type { HonoEnv } from '../types';
import { workspaceMovingResponse } from '@weldsuite/worker-kit/workspace-moving';

type LicenceReadOnlyReason = 'partner_suspended' | 'licence_inactive';
type ReadOnlyReason = LicenceReadOnlyReason | 'database_move';

/**
 * Copy of worker-kit's `computeWorkspaceRestrictions`
 * (`packages/core/worker-kit/src/read-only.ts`): this worker does not depend on
 * worker-kit. Keep the two in step; both have tests.
 */
export function workspaceRestrictions(input: {
  billingMode: string | null | undefined;
  licenceStatus: string | null | undefined;
  licenceApps: readonly string[] | null | undefined;
  partnerStatus: string | null | undefined;
  /** A database move in a write-blocking status; outranks a licence reason. */
  databaseMoveInProgress?: boolean | null;
}): { licensedApps: string[] | null; readOnly: boolean; readOnlyReason: ReadOnlyReason | null } {
  const restrictions = licenceRestrictions(input);
  if (input.databaseMoveInProgress) {
    return { ...restrictions, readOnly: true, readOnlyReason: 'database_move' };
  }
  return restrictions;
}

function licenceRestrictions(input: {
  billingMode: string | null | undefined;
  licenceStatus: string | null | undefined;
  licenceApps: readonly string[] | null | undefined;
  partnerStatus: string | null | undefined;
}): { licensedApps: string[] | null; readOnly: boolean; readOnlyReason: LicenceReadOnlyReason | null } {
  if (input.billingMode !== 'partner') return { licensedApps: null, readOnly: false, readOnlyReason: null };
  let readOnlyReason: LicenceReadOnlyReason | null = null;
  if (input.partnerStatus === 'suspended') readOnlyReason = 'partner_suspended';
  else if (input.licenceStatus !== 'active') readOnlyReason = 'licence_inactive';
  return { licensedApps: [...(input.licenceApps ?? [])], readOnly: readOnlyReason !== null, readOnlyReason };
}

/**
 * Copy of worker-kit's `isReadOnlyRequestAllowed`
 * (`packages/core/worker-kit/src/read-only.ts`): reads always (GET, HEAD,
 * OPTIONS); a write method only on `/v1/search`. No "export" rule: a substring
 * match let any write through, and no public export endpoint is a POST.
 */
export function isReadOnlyRequestAllowed(method: string, path: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return true;
  return path === '/v1/search' || path.startsWith('/v1/search/');
}

/** Copy of worker-kit's `workspaceReadOnlyBody`. */
export function workspaceReadOnlyBody(reason: LicenceReadOnlyReason | null | undefined) {
  const resolved: LicenceReadOnlyReason = reason ?? 'licence_inactive';
  return {
    error: {
      code: 'WORKSPACE_READ_ONLY',
      message:
        resolved === 'partner_suspended'
          ? 'This workspace is read-only because the account that manages it is suspended. You can view and export your data.'
          : 'This workspace is read-only because its licence is not active. You can view and export your data.',
      details: { reason: resolved },
    },
  } as const;
}

export const licenceMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const session = c.get('apiSession');
  const licensedApps = session?.licensedApps;
  if (licensedApps) {
    const missing = missingLicensedApp(findModuleForExternalPath(c.req.path), new Set(licensedApps));
    if (missing) return c.json(appNotLicensedBody(missing), 403);
  }
  // The same exceptions apply whatever the reason (reads, search); only the
  // refusal differs.
  if (session?.readOnly && !isReadOnlyRequestAllowed(c.req.method, c.req.path)) {
    const reason = session.readOnlyReason;
    if (reason === 'database_move') return workspaceMovingResponse(c);
    return c.json(workspaceReadOnlyBody(reason), 403);
  }
  await next();
};
