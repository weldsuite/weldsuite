'use client';

import type { ReactNode } from 'react';
import { PermissionProvider } from '@weldsuite/permissions/react';
import { PreviewModeProvider, type PreviewMode } from '@/contexts/preview-mode-context';
import { PlatformShell } from '@/components/layout/platform-shell';
import SettingsLayout from '@/app/settings/layout';
import { PreviewLiveInstalledApps } from '@/app/preview/appstore/preview-installed-apps';

const PREVIEW_MODE: PreviewMode = { basePath: '/preview', token: 'preview' };

/**
 * Mounts the real Settings module under `/preview/settings/*` without a Clerk
 * session, for support videos. Data comes from Playwright fixtures.
 */
export function PreviewSettingsShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <PreviewModeProvider value={PREVIEW_MODE}>
      <PreviewLiveInstalledApps>
        <PermissionProvider permissions={['*']} isLoading={false} role="OWNER">
          <div data-video-frame className="h-screen w-screen overflow-hidden">
            <PlatformShell embedded>
              <SettingsLayout>{children}</SettingsLayout>
            </PlatformShell>
          </div>
        </PermissionProvider>
      </PreviewLiveInstalledApps>
    </PreviewModeProvider>
  );
}
