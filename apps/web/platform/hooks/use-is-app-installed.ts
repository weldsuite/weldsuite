import { useInstalledApps } from '@/hooks/use-installed-apps';

/**
 * Whether the workspace has an app installed (by app code, e.g. `weldchat`).
 * False while the list is still loading.
 *
 * Shell-level hooks that poll or prefetch a module's API gate on this so a
 * workspace that does not have the module, notably a partner-managed one whose
 * licence leaves it out (the API answers `APP_NOT_LICENSED`), never calls it.
 */
export function useIsAppInstalled(appCode: string): boolean {
  const { data } = useInstalledApps();
  return Boolean(data?.some((app) => app.appCode === appCode));
}
