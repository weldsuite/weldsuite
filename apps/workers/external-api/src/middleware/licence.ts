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
 * Runs after authMiddleware, which puts `licensedApps` and `readOnly` on the
 * session.
 */

import type { MiddlewareHandler } from 'hono';
import { appNotLicensedBody, findModuleForExternalPath, missingLicensedApp } from '@weldsuite/api-modules';
import type { HonoEnv } from '../types';

type ReadOnlyReason = 'partner_suspended' | 'licence_inactive';

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
}): { licensedApps: string[] | null; readOnly: boolean; readOnlyReason: ReadOnlyReason | null } {
  if (input.billingMode !== 'partner') return { licensedApps: null, readOnly: false, readOnlyReason: null };
  const readOnlyReason: ReadOnlyReason | null =
    input.partnerStatus === 'suspended'
      ? 'partner_suspended'
      : input.licenceStatus !== 'active'
        ? 'licence_inactive'
        : null;
  return { licensedApps: [...(input.licenceApps ?? [])], readOnly: readOnlyReason !== null, readOnlyReason };
}

/**
 * Copy of worker-kit's `isReadOnlyRequestAllowed`
 * (`packages/core/worker-kit/src/read-only.ts`): reads always; writes only on
 * read-style POSTs (anything under `/export`, `/v1/search`).
 */
export function isReadOnlyRequestAllowed(method: string, path: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return true;
  if (path.includes('/export')) return true;
  return path === '/v1/search' || path.startsWith('/v1/search/');
}

/** Copy of worker-kit's `workspaceReadOnlyBody`. */
export function workspaceReadOnlyBody(reason: ReadOnlyReason | null | undefined) {
  const resolved: ReadOnlyReason = reason ?? 'licence_inactive';
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
  if (session?.readOnly && !isReadOnlyRequestAllowed(c.req.method, c.req.path)) {
    return c.json(workspaceReadOnlyBody(session.readOnlyReason), 403);
  }
  await next();
};
