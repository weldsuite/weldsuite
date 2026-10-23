'use client';

import type { ReactNode } from 'react';
import { PermissionProvider } from '@weldsuite/permissions/react';
import { PreviewInstalledAppsProvider } from '@/contexts/preview-installed-apps-context';
import { PreviewModeProvider, type PreviewMode } from '@/contexts/preview-mode-context';
import { PlatformShell } from '@/components/layout/platform-shell';
import WeldSheetsLayout from '@/app/weldsheets/layout';
import { previewInstalledApps } from '@/app/preview/help-docs/fixtures';

const PREVIEW_MODE: PreviewMode = { basePath: '/preview', token: 'preview' };

const PREVIEW_APPS = [
  ...previewInstalledApps,
  { ...previewInstalledApps[0]!, id: 'weldsheets', appCode: 'weldsheets', name: 'WeldSheets', displayOrder: previewInstalledApps.length },
];

/**
 * Mounts the real WeldSheets module under `/preview/weldsheets/*` without a
 * Clerk session, for support videos and help screenshots. Spreadsheets are
 * kept in this browser under a "preview" workspace.
 */
export function PreviewWeldSheetsShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <PreviewModeProvider value={PREVIEW_MODE}>
      <PreviewInstalledAppsProvider apps={PREVIEW_APPS}>
        <PermissionProvider permissions={['*']} isLoading={false} role="OWNER">
          <div data-video-frame className="h-screen w-screen overflow-hidden">
            <PlatformShell embedded>
              <WeldSheetsLayout>{children}</WeldSheetsLayout>
            </PlatformShell>
          </div>
        </PermissionProvider>
      </PreviewInstalledAppsProvider>
    </PreviewModeProvider>
  );
}
