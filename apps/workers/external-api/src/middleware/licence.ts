/**
 * App licence check for the public API. A partner-managed workspace carries a
 * licence listing the apps it may use (docs/plans/reseller-licensing.md); a
 * call into a module none of them reads is rejected with 403 APP_NOT_LICENSED.
 * Uses the same module table as the first-party workers' `licenceGate()`
 * (`@weldsuite/api-modules`), mapping `/v1/<object>` onto its module.
 *
 * Runs after authMiddleware, which puts `licensedApps` on the session.
 */

import type { MiddlewareHandler } from 'hono';
import { appNotLicensedBody, findModuleForExternalPath, missingLicensedApp } from '@weldsuite/api-modules';
import type { HonoEnv } from '../types';

export const licenceMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const licensedApps = c.get('apiSession')?.licensedApps;
  if (licensedApps) {
    const missing = missingLicensedApp(findModuleForExternalPath(c.req.path), new Set(licensedApps));
    if (missing) return c.json(appNotLicensedBody(missing), 403);
  }
  await next();
};
