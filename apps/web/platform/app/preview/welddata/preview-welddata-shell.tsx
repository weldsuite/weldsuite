'use client';

import type { ReactNode } from 'react';
import { PermissionProvider } from '@weldsuite/permissions/react';
import { PreviewInstalledAppsProvider } from '@/contexts/preview-installed-apps-context';
import { PreviewModeProvider, type PreviewMode } from '@/contexts/preview-mode-context';
import { PlatformShell } from '@/components/layout/platform-shell';
import WelddataLayout from '@/app/welddata/layout';
import { previewInstalledApps } from '@/app/preview/help-docs/fixtures';

const PREVIEW_MODE: PreviewMode = { basePath: '/preview', token: 'preview' };

// The shared help-docs fixture does not list WeldData, so add it to the rail.
const installedApps = [
  ...previewInstalledApps.filter((app) => app.appCode !== 'welddata'),
  {
    id: 'welddata',
    workspaceId: 'ws_help_preview',
    appCode: 'welddata',
    name: 'WeldData',
    status: 'active',
    installedAt: '2026-01-15T12:00:00.000Z',
    displayOrder: previewInstalledApps.length,
    appType: 'system' as const,
  },
];

/**
 * Mounts the real WeldData module under `/preview/welddata/*` without a Clerk
 * session, for support videos. Data comes from whatever answers the API
 * requests: in `apps/web/docs/scripts/record-videos.mjs` that is Playwright
 * fixtures; opened directly in a browser the lists and results are empty.
 */
export function PreviewWelddataShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <PreviewModeProvider value={PREVIEW_MODE}>
      <PreviewInstalledAppsProvider apps={installedApps}>
        <PermissionProvider permissions={['*']} isLoading={false} role="OWNER">
          <div data-video-frame className="h-screen w-screen overflow-hidden">
            <PlatformShell embedded>
              <WelddataLayout>{children}</WelddataLayout>
            </PlatformShell>
          </div>
        </PermissionProvider>
      </PreviewInstalledAppsProvider>
    </PreviewModeProvider>
  );
}
