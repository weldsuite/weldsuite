/**
 * Whether `app/weldmail/layout.tsx` can render the mail shell, from the
 * installed-apps gate's live and cached state
 * (docs/plans/weldmail-mailbox-storage.md phase 1 item 10).
 *
 * A cached "installed" answer — this page's own earlier fetch, or the
 * persisted query cache restored from a previous session — lets mail render
 * before the live check (`useAppAccess('weldmail')`, via `useInstalledApps`)
 * resolves. Once the live check resolves, it wins outright: a revoked install
 * still blocks, and a cached "not installed" (or no cache at all) never shows
 * mail early.
 */
export function canRenderMailGate(live: { isLoading: boolean; isInstalled: boolean }, cachedInstalled: boolean): boolean {
  return live.isLoading ? cachedInstalled : live.isInstalled;
}

export interface CachedInstalledAppLike {
  appCode: string;
  status: string;
}

/** Whether a cached installed-apps list already says WeldMail is active. */
export function cachedWeldmailInstalled(apps: readonly CachedInstalledAppLike[] | undefined): boolean {
  return apps?.some((app) => app.appCode.toLowerCase() === 'weldmail' && app.status === 'active') ?? false;
}
