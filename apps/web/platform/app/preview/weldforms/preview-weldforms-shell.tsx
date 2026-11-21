'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { PermissionProvider } from '@weldsuite/permissions/react';
import { PreviewInstalledAppsProvider } from '@/contexts/preview-installed-apps-context';
import { PreviewModeProvider, type PreviewMode } from '@/contexts/preview-mode-context';
import { PlatformShell } from '@/components/layout/platform-shell';
import WeldFormsLayout from '@/app/weldforms/layout';
import { previewInstalledApps } from '@/app/preview/help-docs/fixtures';
import { installWeldFormsMockFetch } from './mock-api';

const PREVIEW_MODE: PreviewMode = { basePath: '/preview', token: 'preview' };

const PREVIEW_APPS = [
  ...previewInstalledApps,
  { ...previewInstalledApps[0]!, id: 'weldforms', appCode: 'weldforms', name: 'WeldForms', displayOrder: previewInstalledApps.length },
];

/**
 * Mounts the real WeldForms module under `/preview/weldforms/*` without a Clerk
 * session or a backend, for visual checks, support videos and help screenshots.
 *
 * The API is answered in the browser by `mock-api.ts` (forms, responses,
 * invitations, integrations, themes, settings and usage from `fixtures.ts`), so
 * the page works in a plain browser; edits stay in memory until a reload. The
 * mock is installed while rendering, before any query fires, and removed on
 * unmount so other preview scenes keep the real `fetch`.
 */
export function PreviewWeldFormsShell({ children }: Readonly<{ children: ReactNode }>) {
  useState(() => installWeldFormsMockFetch());
  useEffect(() => {
    const uninstall = installWeldFormsMockFetch();
    return uninstall;
  }, []);

  return (
    <PreviewModeProvider value={PREVIEW_MODE}>
      <PreviewInstalledAppsProvider apps={PREVIEW_APPS}>
        <PermissionProvider permissions={['*']} isLoading={false} role="OWNER">
          <div data-video-frame data-screenshot-frame className="h-screen w-screen overflow-hidden">
            <PlatformShell embedded>
              <WeldFormsLayout>{children}</WeldFormsLayout>
            </PlatformShell>
          </div>
        </PermissionProvider>
      </PreviewInstalledAppsProvider>
    </PreviewModeProvider>
  );
}
