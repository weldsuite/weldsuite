import { useMemo } from 'react';
import { useInstalledUserApps, useUserAppDevSession } from '@/hooks/queries/use-user-apps-queries';
import { getAppApiUrl } from '@/lib/api/public-env';
import { iframeSandbox, iframeTargetOrigin } from './preview';

export const APP_API_BASE = getAppApiUrl();

/**
 * Resolve what to load for `appCode`: the installed app row, and the iframe
 * source — the developer's `weld app dev` preview when one is active, else
 * the published bundle on app-api.
 */
export function useWeldAppSource(appCode: string | undefined) {
  const { data: installedApps, isLoading } = useInstalledUserApps();
  const { data: devSession } = useUserAppDevSession(appCode);

  const app = installedApps?.find((a) => a.appCode === appCode);
  const previewUrl = devSession?.url ?? null;
  const bundleSrc = appCode ? `${APP_API_BASE}/public/user-apps/${appCode}/index.html` : '';
  const iframeSrc = previewUrl ?? bundleSrc;

  return useMemo(
    () => ({
      app,
      isLoading,
      previewUrl,
      iframeSrc,
      targetOrigin: iframeTargetOrigin(iframeSrc),
      sandbox: iframeSandbox(iframeSrc),
      /**
       * First-party apps (and the legacy weldcommerce hosted app) act with
       * the member's platform session against app-api; community apps go
       * through the scoped gateway to external-api.
       */
      usesPlatformSession: app?.publisherType === 'weldsuite' || appCode === 'weldcommerce',
    }),
    [app, isLoading, previewUrl, iframeSrc, appCode],
  );
}

/**
 * Bootstrap theme + route into the URL so first paint already matches the
 * platform. Only used for the initial `src`; later changes go over the bridge
 * so the iframe never reloads on navigation.
 */
export function bootstrapFrameSrc(src: string, theme: 'light' | 'dark', path: string): string {
  if (!src) return src;
  try {
    const url = new URL(src);
    url.searchParams.set('theme', theme);
    url.hash = path && path !== '/' ? path.replace(/^\//, '') : '';
    return url.toString();
  } catch {
    return src;
  }
}
