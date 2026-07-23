
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useInstalledUserApps } from '@/hooks/queries/use-user-apps-queries';
import type { InstalledApp } from '@/lib/api/apps';

// Client-side app name mapping (matches server-side APP_CATALOG)
const APP_NAMES: Record<string, string> = {
  weldcrm: 'WeldCRM',
  welddesk: 'WeldDesk',
  weldmail: 'WeldMail',
  weldflow: 'WeldFlow',
  weldconnect: 'WeldConnect',
  weldhost: 'WeldHost',
  weldstash: 'WeldStash',
  weldbooks: 'WeldBooks',
  parcel: 'Parcel',
  social: 'Social',
  weldchat: 'WeldChat',
  weldmeet: 'WeldMeet',
  weldcalendar: 'WeldCalendar',
  welddrive: 'WeldDrive',
  welddata: 'WeldData',
  weldknow: 'WeldKnow'
};

export const installedAppsKeys = {
  // Prefix used by mutation hooks to invalidate every workspace's list.
  all: ['installed-apps'] as const,
  // The actual query is scoped by the active Clerk org so one workspace's
  // apps never hydrate into another's cache after a switch.
  byOrg: (orgId: string | null | undefined) => ['installed-apps', orgId ?? 'none'] as const,
};

/**
 * Client-side hook to fetch installed apps.
 * Fetches app codes from the worker API and constructs InstalledApp objects.
 */
export function useInstalledApps() {
  // Reads from app-api (the new unified backend) rather than the legacy
  // api-worker — completing the installed-apps consolidation. app-api serves
  // GET /api/dashboard/installed-apps from the same workspace_installed_apps
  // tenant table the install path writes to.
  const { getClient } = useAppApiClient();
  const { orgId } = useAuth();

  const systemAppsQuery = useQuery<InstalledApp[]>({
    queryKey: installedAppsKeys.byOrg(orgId),
    enabled: !!orgId,
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: string[] }>('/dashboard/installed-apps');
      const codes = res?.data || [];
      // De-dupe defensively so the same app never renders twice in the sidebar.
      const seen = new Set<string>();
      const apps: InstalledApp[] = [];
      for (const code of codes) {
        if (seen.has(code)) continue;
        seen.add(code);
        apps.push({
          id: code,
          workspaceId: '',
          appCode: code,
          name: APP_NAMES[code] || code.charAt(0).toUpperCase() + code.slice(1),
          status: 'active',
          installedAt: new Date().toISOString(),
          displayOrder: apps.length,
          appType: 'system',
        });
      }
      return apps;
    },
    // No per-hook staleTime override: inherit the global SWR fetch cache
    // (staleTime: 0). The persisted cache renders the sidebar instantly on
    // load, then a background refetch revalidates and updates the apps list.
  });

  // WeldApps — workspace-created apps installed alongside the first-party
  // system apps. Merged in here (rather than in every consumer) so the
  // sidenav, mobile sidebar, and app-access guard all see one combined list.
  const userAppsQuery = useInstalledUserApps();

  const data = useMemo<InstalledApp[] | undefined>(() => {
    // Mirror the "wait for the real fetch" semantics AppAccessGuard depends
    // on: don't synthesize a combined `[]` before the system-apps query has
    // actually resolved once.
    if (!systemAppsQuery.data) return systemAppsQuery.data;

    const merged = [...systemAppsQuery.data];
    const seenCodes = new Set(merged.map((a) => a.appCode));
    for (const userApp of userAppsQuery.data ?? []) {
      if (seenCodes.has(userApp.appCode)) continue;
      seenCodes.add(userApp.appCode);
      merged.push({
        id: userApp.userAppId,
        workspaceId: '',
        appCode: userApp.appCode,
        name: userApp.name,
        icon: userApp.icon ?? undefined,
        status: 'active',
        installedAt: new Date().toISOString(),
        displayOrder: merged.length,
        appType: 'user',
      });
    }
    return merged;
  }, [systemAppsQuery.data, userAppsQuery.data]);

  return {
    data,
    isLoading: systemAppsQuery.isLoading || userAppsQuery.isLoading,
  };
}
