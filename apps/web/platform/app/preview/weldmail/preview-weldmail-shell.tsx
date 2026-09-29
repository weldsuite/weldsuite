'use client';

import type { ReactNode } from 'react';
import { PermissionProvider } from '@weldsuite/permissions/react';
import { PreviewInstalledAppsProvider } from '@/contexts/preview-installed-apps-context';
import { PreviewModeProvider, type PreviewMode } from '@/contexts/preview-mode-context';
import { PlatformShell } from '@/components/layout/platform-shell';
import MailLayout from '@/app/weldmail/layout';
import { previewInstalledApps } from '@/app/preview/help-docs/fixtures';

const PREVIEW_MODE: PreviewMode = { basePath: '/preview', token: 'preview' };

/**
 * Mounts the real WeldMail module under `/preview/weldmail/*` without a Clerk
 * session, for support videos. Data comes from whatever answers the API
 * requests: in `apps/web/docs/scripts/record-videos.mjs` that is Playwright
 * fixtures; opened directly in a browser the lists are simply empty.
 */
export function PreviewWeldMailShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <PreviewModeProvider value={PREVIEW_MODE}>
      <PreviewInstalledAppsProvider apps={previewInstalledApps}>
        <PermissionProvider permissions={['*']} isLoading={false} role="OWNER">
          <div data-video-frame className="h-screen w-screen overflow-hidden">
            <PlatformShell embedded>
              <MailLayout>{children}</MailLayout>
            </PlatformShell>
          </div>
        </PermissionProvider>
      </PreviewInstalledAppsProvider>
    </PreviewModeProvider>
  );
}
