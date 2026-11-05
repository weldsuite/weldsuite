'use client';

import type { ReactNode } from 'react';
import { PermissionProvider } from '@weldsuite/permissions/react';
import { PreviewInstalledAppsProvider } from '@/contexts/preview-installed-apps-context';
import { PreviewModeProvider, type PreviewMode } from '@/contexts/preview-mode-context';
import { PlatformShell } from '@/components/layout/platform-shell';
import WeldBoardLayout from '@/app/weldboard/layout';
import { previewInstalledApps } from '@/app/preview/help-docs/fixtures';

const PREVIEW_MODE: PreviewMode = { basePath: '/preview', token: 'preview' };

const PREVIEW_APPS = [
  ...previewInstalledApps,
  { ...previewInstalledApps[0]!, id: 'weldboard', appCode: 'weldboard', name: 'WeldBoard', displayOrder: previewInstalledApps.length },
];

/**
 * Mounts the real WeldBoard module under `/preview/weldboard/*` without a
 * Clerk session, for support videos and help screenshots. Boards are
 * kept in this browser under a "preview" workspace.
 */
export function PreviewWeldBoardShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <PreviewModeProvider value={PREVIEW_MODE}>
      <PreviewInstalledAppsProvider apps={PREVIEW_APPS}>
        <PermissionProvider permissions={['*']} isLoading={false} role="OWNER">
          <div data-video-frame className="h-screen w-screen overflow-hidden">
            <PlatformShell embedded>
              <WeldBoardLayout>{children}</WeldBoardLayout>
            </PlatformShell>
          </div>
        </PermissionProvider>
      </PreviewInstalledAppsProvider>
    </PreviewModeProvider>
  );
}
