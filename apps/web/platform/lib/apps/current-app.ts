/**
 * The app (module) a platform URL belongs to, as the canonical permission app
 * code: `/weldcrm/companies` → `weldcrm`, `/social/posts` → `weldsocial`,
 * `/apps/weldcommerce/...` → `weldcommerce`. Workspace surfaces (`/settings`,
 * `/appstore`, `/objects`, `/`) have no app and return null, which the
 * permission checks treat as "allowed in any app".
 *
 * Shared by the PermissionProvider (client-side `can()`) and the X-Weld-App
 * request header (server-side requirePermission), so both evaluate the same
 * app for the same screen.
 */

import { isAppCode, normalizeAppCode } from '@weldsuite/permissions';

export function appFromPathname(pathname: string): string | null {
  const [first, second] = pathname.split('/').filter(Boolean);
  if (!first) return null;
  // First-party apps served through the WeldApps host (`/apps/weldcommerce`).
  if (first === 'apps') return second && isAppCode(second) ? second : null;
  return normalizeAppCode(first);
}
