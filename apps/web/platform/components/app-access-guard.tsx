import { useEffect } from 'react';
import { usePathname, useRouter } from '@/lib/router';
import { useInstalledApps } from '@/hooks/use-installed-apps';
import { useIsEmployeeMember, useIsGuest } from '@/hooks/use-current-member';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { getAppPermissionObjects } from '@/lib/apps/app-permission-objects';

// `/documents` is the shared full-screen document editor — an app-agnostic
// surface keyed by file id, reachable from WeldFlow, WeldDrive, etc. Its first
// path segment isn't an installed app code, so it must be allow-listed here or
// the app-installed check below would bounce it to `/`. Access to the file
// itself is enforced server-side when its content is fetched.
// `/apps/{code}` is the WeldApps sandboxed-iframe host + `/apps/manage` is the
// developer UI — neither's first path segment ("apps") is an installed app
// code, so both would otherwise trip the "app not installed" redirect below.
// The host page does its own is-installed check against useInstalledUserApps,
// and /apps/manage gates itself on the weldapps:develop permission.
const ALWAYS_ALLOWED_PREFIXES = ['/settings', '/appstore', '/onboarding', '/agents', '/new-chat', '/documents', '/apps', '/preview'];

/**
 * Path prefixes EXTERNAL_GUEST users can navigate to in v1. Anything else
 * gets redirected to /weldchat. Mirrors the api-worker guest-scope
 * allowlist in spirit — the SERVER is the real ceiling, this is just for
 * UX so guests don't see "Forbidden" toasts when bookmarks send them
 * somewhere they shouldn't be.
 */
const GUEST_ALLOWED_PREFIXES = ['/weldchat'];

/** Where guests land when they hit a disallowed route. */
const GUEST_FALLBACK_PATH = '/weldchat';

/**
 * Where EMPLOYEE members (WeldHR) may go: My HR, reporting sick, WeldChat and
 * their own account settings. Same idea as the guest list: the server ceiling is their
 * fixed permission set, this only keeps them off pages that would 403.
 */
const EMPLOYEE_ALLOWED_PREFIXES = [
  '/weldhr/me',
  '/weldhr/absenteeism',
  '/weldchat',
  '/settings/appearance',
  '/settings/notifications',
  '/settings/shortcuts',
  '/settings/security',
  '/settings/desktop',
];
/** Exact paths EMPLOYEE members may open ("/settings" is their profile). */
const EMPLOYEE_ALLOWED_PATHS = ['/settings'];
const EMPLOYEE_FALLBACK_PATH = '/weldhr/me';

function matchesPrefix(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'));
}

function getAppCodeFromPathname(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  return segments[0];
}

export function AppAccessGuard({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: installedApps, isLoading } = useInstalledApps();
  const perms = usePermissionsMaybe();
  const isGuest = useIsGuest();
  const isEmployeeMember = useIsEmployeeMember();

  useEffect(() => {
    if (isLoading || perms?.isLoading) return;
    // Wait for the installed-apps query to actually resolve. `data` is
    // undefined while the query is disabled (e.g. orgId briefly falsy
    // during a re-render) or before the first response — defaulting to []
    // here would falsely trip the "app not installed" redirect.
    if (!installedApps) return;

    // Guest gate runs first — redirect to /weldchat for any path outside
    // the guest allowlist. Root path "/" is also redirected so guests
    // land directly in chat instead of an empty dashboard.
    if (isGuest) {
      if (!matchesPrefix(pathname, GUEST_ALLOWED_PREFIXES) && pathname !== GUEST_FALLBACK_PATH) {
        router.replace(GUEST_FALLBACK_PATH);
      }
      return;
    }

    // EMPLOYEE members: My HR + WeldChat only; "/" lands them in My HR
    // (or chat, should WeldHR have been uninstalled).
    if (isEmployeeMember) {
      const allowed =
        EMPLOYEE_ALLOWED_PATHS.includes(pathname) || matchesPrefix(pathname, EMPLOYEE_ALLOWED_PREFIXES);
      const fallback = installedApps.some((app) => app.appCode === 'weldhr')
        ? EMPLOYEE_FALLBACK_PATH
        : GUEST_FALLBACK_PATH;
      if (!allowed && pathname !== fallback) {
        router.replace(fallback);
      }
      return;
    }

    // Always allow root and system paths
    if (
      pathname === '/' ||
      ALWAYS_ALLOWED_PREFIXES.some(
        (prefix) => pathname === prefix || pathname.startsWith(prefix + '/')
      )
    ) {
      return;
    }

    const appCode = getAppCodeFromPathname(pathname);
    if (!appCode) return;

    // Check 1: Is the app installed for this workspace?
    const isInstalled = installedApps.some((app) => app.appCode === appCode);
    if (!isInstalled) {
      router.replace('/');
      return;
    }

    // Check 2: Does the user have any permission for this app?
    // Uses the platform-level APP_PERMISSION_OBJECTS map, which covers both
    // legacy apps (auto-derived from the migration map) and apps introduced
    // after the permissions refactor (e.g. weldcall). Checked in THIS app:
    // `companies` granted only in WeldCRM does not open WeldDesk.
    if (perms && !perms.isOwner) {
      const objects = getAppPermissionObjects(appCode);
      if (objects.length === 0 || !perms.hasAnyObject(objects, appCode)) {
        router.replace('/');
      }
    }
  }, [pathname, installedApps, isLoading, router, perms, isGuest, isEmployeeMember]);

  return <>{children}</>;
}
