import { useEffect } from 'react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePathname, useRouter } from '@/lib/router';
import { getFirstPartyAppName, useInstalledApps } from '@/hooks/use-installed-apps';
import { useIsEmployeeMember, useIsGuest } from '@/hooks/use-current-member';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { getAppPermissionObjects } from '@/lib/apps/app-permission-objects';
import { useCanManageApps } from '@/hooks/queries/use-settings-queries';
import { isModuleOffered } from '@/lib/edition';

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

/** WeldAgent's pages: workspace-level rather than an installed app, served by the agent module. */
const AGENT_PREFIXES = ['/agents', '/new-chat'];

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
 * Where EMPLOYEE members (WeldHR) may go: My HR (reporting sick included),
 * WeldChat and their own account settings. Same idea as the guest list: the server ceiling is their
 * fixed permission set, this only keeps them off pages that would 403.
 */
const EMPLOYEE_ALLOWED_PREFIXES = [
  '/weldhr/me',
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

type InstalledAppList = NonNullable<ReturnType<typeof useInstalledApps>['data']>;
type Permissions = ReturnType<typeof usePermissionsMaybe>;

/** Where to send the member instead, and the app that isn't installed (for the toast). */
interface AccessRedirect {
  to: string;
  notInstalledApp?: string;
}

/**
 * Guest gate: redirect to /weldchat for any path outside the guest allowlist.
 * Root path "/" is also redirected so guests land directly in chat instead of
 * an empty dashboard.
 */
function guestRedirect(pathname: string): AccessRedirect | null {
  if (matchesPrefix(pathname, GUEST_ALLOWED_PREFIXES) || pathname === GUEST_FALLBACK_PATH) return null;
  return { to: GUEST_FALLBACK_PATH };
}

/**
 * EMPLOYEE members: My HR + WeldChat only; "/" lands them in My HR (or chat,
 * should WeldHR have been uninstalled).
 */
function employeeRedirect(pathname: string, installedApps: InstalledAppList): AccessRedirect | null {
  const allowed = EMPLOYEE_ALLOWED_PATHS.includes(pathname) || matchesPrefix(pathname, EMPLOYEE_ALLOWED_PREFIXES);
  const fallback = installedApps.some((app) => app.appCode === 'weldhr') ? EMPLOYEE_FALLBACK_PATH : GUEST_FALLBACK_PATH;
  return allowed || pathname === fallback ? null : { to: fallback };
}

/** Members: the app behind the path must be installed and readable. */
function memberRedirect(pathname: string, installedApps: InstalledAppList, perms: Permissions): AccessRedirect | null {
  // Edition flags (4.F3): WeldAgent's pages need the agent module.
  if (!isModuleOffered('agent') && matchesPrefix(pathname, AGENT_PREFIXES)) return { to: '/' };

  // Always allow root and system paths
  if (pathname === '/' || matchesPrefix(pathname, ALWAYS_ALLOWED_PREFIXES)) return null;

  // WeldObjects live at `/objects/{slug}`. The slug is the object's code in
  // the installed-app list, which only holds active objects the member may
  // read, so being listed is the whole check.
  const [firstSegment, objectSlug] = pathname.split('/').filter(Boolean);
  if (firstSegment === 'objects') {
    const isListed = installedApps.some((app) => app.appType === 'object' && app.appCode === objectSlug);
    return isListed ? null : { to: '/' };
  }

  const appCode = getAppCodeFromPathname(pathname);
  if (!appCode) return null;

  // Check 1: Is the app installed for this workspace?
  if (!installedApps.some((app) => app.appCode === appCode)) return { to: '/', notInstalledApp: appCode };

  // Check 2: Does the user have any permission for this app?
  // Uses the platform-level APP_PERMISSION_OBJECTS map, which covers both
  // legacy apps (auto-derived from the migration map) and apps introduced
  // after the permissions refactor (e.g. weldcall). Checked in THIS app:
  // `companies` granted only in WeldCRM does not open WeldDesk.
  if (perms && !perms.isOwner) {
    const objects = getAppPermissionObjects(appCode);
    if (objects.length === 0 || !perms.hasAnyObject(objects, appCode)) return { to: '/' };
  }
  return null;
}

/**
 * Say why a first-party app's page didn't open (an unknown first segment is
 * just a bad URL and keeps the silent redirect). A member's installed-app list
 * only holds the apps their role grants, so "not installed" plus the App Store
 * link is only said to someone who manages apps, whose list is the full set;
 * everyone else gets wording that covers both "not installed" and "no access".
 */
function notifyUnavailableApp(
  appCode: string,
  canManageApps: boolean,
  t: ReturnType<typeof useTranslations>,
  openAppStore: () => void,
): void {
  const app = getFirstPartyAppName(appCode);
  if (!app) return;
  const id = `app-not-installed-${appCode}`;
  if (canManageApps) {
    toast.info(t('common.empty.appNotInstalledNamed', { app }), {
      id,
      description: t('common.empty.appNotInstalledHint'),
      action: { label: t('common.empty.openAppStore'), onClick: openAppStore },
    });
  } else {
    toast.info(t('common.empty.appUnavailableNamed', { app }), {
      id,
      description: t('common.empty.appUnavailableHint'),
    });
  }
}

export function AppAccessGuard({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: installedApps, isLoading } = useInstalledApps();
  const perms = usePermissionsMaybe();
  const isGuest = useIsGuest();
  const isEmployeeMember = useIsEmployeeMember();
  const t = useTranslations();
  const { data: canManageApps } = useCanManageApps();

  useEffect(() => {
    if (isLoading || perms?.isLoading) return;
    // Wait for the installed-apps query to actually resolve. `data` is
    // undefined while the query is disabled (e.g. orgId briefly falsy
    // during a re-render) or before the first response — defaulting to []
    // here would falsely trip the "app not installed" redirect.
    if (!installedApps) return;

    let redirect: AccessRedirect | null;
    if (isGuest) redirect = guestRedirect(pathname);
    else if (isEmployeeMember) redirect = employeeRedirect(pathname, installedApps);
    else redirect = memberRedirect(pathname, installedApps, perms);
    if (!redirect) return;

    if (redirect.notInstalledApp) {
      notifyUnavailableApp(redirect.notInstalledApp, canManageApps === true, t, () => router.push('/appstore'));
    }
    router.replace(redirect.to);
  }, [pathname, installedApps, isLoading, router, perms, isGuest, isEmployeeMember, t, canManageApps]);

  return <>{children}</>;
}
