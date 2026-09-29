'use client';

import { useLayoutEffect, type ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';
import { PermissionProvider } from '@weldsuite/permissions/react';
import { PreviewInstalledAppsProvider } from '@/contexts/preview-installed-apps-context';
import { PreviewModeProvider, type PreviewMode } from '@/contexts/preview-mode-context';
import { PlatformShell } from '@/components/layout/platform-shell';
import CalendarLayout from '@/app/weldcalendar/layout';
import { previewInstalledApps } from '@/app/preview/help-docs/fixtures';

const PREVIEW_MODE: PreviewMode = { basePath: '/preview', token: 'preview' };

/**
 * Most WeldCalendar screens navigate with TanStack's `useNavigate()` and absolute
 * `/weldcalendar/...` paths (not the `@/lib/router` wrappers that know about
 * preview mode), which would leave the unauthenticated `/preview` mirror for the
 * auth-gated real routes. Map those locations back under `/preview` when the
 * router reads them, so the same components keep working here unchanged.
 */
function useKeepWeldCalendarNavigationInPreview() {
  const router = useRouter();
  useLayoutEffect(() => {
    const previousRewrite = router.options.rewrite;
    router.update({
      ...router.options,
      rewrite: {
        input: ({ url }) => {
          if (/^\/weldcalendar(\/|$)/.test(url.pathname)) url.pathname = `${PREVIEW_MODE.basePath}${url.pathname}`;
          return url;
        },
      },
    });
    return () => router.update({ ...router.options, rewrite: previousRewrite });
  }, [router]);
}

/**
 * Mounts the real WeldCalendar module under `/preview/weldcalendar/*` without a
 * Clerk session, for support videos. Data comes from whatever answers the API
 * requests: in `apps/web/docs/scripts/record-videos.mjs` that is Playwright
 * fixtures; opened directly in a browser the lists are simply empty.
 */
export function PreviewWeldCalendarShell({ children }: Readonly<{ children: ReactNode }>) {
  useKeepWeldCalendarNavigationInPreview();
  return (
    <PreviewModeProvider value={PREVIEW_MODE}>
      <PreviewInstalledAppsProvider apps={previewInstalledApps}>
        <PermissionProvider permissions={['*']} isLoading={false} role="OWNER">
          <div data-video-frame className="h-screen w-screen overflow-hidden">
            <PlatformShell embedded>
              <CalendarLayout>{children}</CalendarLayout>
            </PlatformShell>
          </div>
        </PermissionProvider>
      </PreviewInstalledAppsProvider>
    </PreviewModeProvider>
  );
}
