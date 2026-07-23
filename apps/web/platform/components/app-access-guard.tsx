import { useEffect } from 'react';
import { usePathname, useRouter } from '@/lib/router';
import { useInstalledApps } from '@/hooks/use-installed-apps';
import { useIsGuest } from '@/hooks/use-current-member';
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
const ALWAYS_ALLOWED_PREFIXES = ['/settings', '/appstore', '/onboarding', '/agents', '/new-chat', '/documents', '/apps'];

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

function getAppCodeFromPathname(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  return segments[0];
}

export function AppAccessGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: installedApps, isLoading } = useInstalledApps();
  const perms = usePermissionsMaybe();
  const isGuest = useIsGuest();

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
      const allowed = GUEST_ALLOWED_PREFIXES.some(
        (prefix) => pathname === prefix || pathname.startsWith(prefix + '/'),
      );
      if (!allowed && pathname !== GUEST_FALLBACK_PATH) {
        router.replace(GUEST_FALLBACK_PATH);
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
    // after the permissions refactor (e.g. weldcall).
    if (perms && !perms.isOwner) {
      const objects = getAppPermissionObjects(appCode);
      if (objects.length === 0 || !perms.hasAnyObject(objects)) {
        router.replace('/');
      }
    }
  }, [pathname, installedApps, isLoading, router, perms, isGuest]);

  return <>{children}</>;
}
