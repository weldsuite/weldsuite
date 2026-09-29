'use client';

import type { ReactNode } from 'react';
import { PermissionProvider } from '@weldsuite/permissions/react';
import { PreviewModeProvider, type PreviewMode } from '@/contexts/preview-mode-context';
import { PlatformShell } from '@/components/layout/platform-shell';
import AppStoreLayout from '@/app/appstore/layout';
import { PreviewLiveInstalledApps } from './preview-installed-apps';

const PREVIEW_MODE: PreviewMode = { basePath: '/preview', token: 'preview' };

/**
 * Mounts the real App Store under `/preview/appstore/*` without a Clerk
 * session, for support videos. Data comes from Playwright fixtures.
 */
export function PreviewAppStoreShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <PreviewModeProvider value={PREVIEW_MODE}>
      <PreviewLiveInstalledApps>
        <PermissionProvider permissions={['*']} isLoading={false} role="OWNER">
          <div data-video-frame className="h-screen w-screen overflow-hidden">
            <PlatformShell embedded>
              <AppStoreLayout>{children}</AppStoreLayout>
            </PlatformShell>
          </div>
        </PermissionProvider>
      </PreviewLiveInstalledApps>
    </PreviewModeProvider>
  );
}
