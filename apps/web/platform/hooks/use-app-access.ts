
import { useInstalledApps } from './use-installed-apps';

/**
 * Client-side replacement for server-side `checkAppAccess()`.
 * Returns whether the given app is installed and active for the current workspace.
 */
export function useAppAccess(appCode: string) {
  const { data: apps, isLoading } = useInstalledApps();
  const isInstalled = apps?.some(
    (app) => app.appCode.toLowerCase() === appCode.toLowerCase() && app.status === 'active'
  );

  return { isInstalled: isInstalled ?? true, isLoading };
}
