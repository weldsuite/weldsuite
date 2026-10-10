/**
 * Server-side app licence check. A partner-managed workspace carries a licence
 * listing the apps it may use (docs/plans/reseller-licensing.md); a request to
 * a module none of those apps reads is rejected with 403 APP_NOT_LICENSED.
 *
 * The browser's AppAccessGuard only hides screens, so without this an
 * unlicensed module's API would stay fully usable. Which apps open which
 * module is declared per module in `@weldsuite/api-modules` (`apps`). Core
 * platform paths and workspaces without a licence (`licensedApps` null) pass.
 *
 * Runs after workspaceDbMiddleware, which sets `licensedApps`.
 */

import { createMiddleware } from 'hono/factory';
import { appNotLicensedBody, findModuleForPath, missingLicensedApp } from '@weldsuite/api-modules';

type LicenceGateVariables = {
  licensedApps?: readonly string[] | null;
};

export const licenceGate = () => {
  return createMiddleware<{ Variables: LicenceGateVariables }>(async (c, next) => {
    const licensedApps = c.get('licensedApps');
    if (licensedApps) {
      const missing = missingLicensedApp(findModuleForPath(c.req.path), new Set(licensedApps));
      if (missing) return c.json(appNotLicensedBody(missing), 403);
    }
    await next();
  });
};
