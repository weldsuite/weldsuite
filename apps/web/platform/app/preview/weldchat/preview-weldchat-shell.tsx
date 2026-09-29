'use client';

import type { ReactNode } from 'react';
import { PermissionProvider } from '@weldsuite/permissions/react';
import { PreviewInstalledAppsProvider } from '@/contexts/preview-installed-apps-context';
import { PreviewModeProvider, type PreviewMode } from '@/contexts/preview-mode-context';
import { PlatformShell } from '@/components/layout/platform-shell';
import ChatLayout from '@/app/weldchat/layout';
import { WeldChatCallProvider } from '@/contexts/weldchat-call-context';
import { previewInstalledApps } from '@/app/preview/help-docs/fixtures';

const PREVIEW_MODE: PreviewMode = { basePath: '/preview', token: 'preview' };

/**
 * Mounts the real WeldChat module under `/preview/weldchat/*` without a Clerk
 * session, for support videos. Data comes from whatever answers the API
 * requests: in `apps/web/docs/scripts/record-videos.mjs` that is Playwright
 * fixtures; opened directly in a browser the lists are simply empty.
 */
export function PreviewWeldChatShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <PreviewModeProvider value={PREVIEW_MODE}>
      <PreviewInstalledAppsProvider apps={previewInstalledApps}>
        <PermissionProvider permissions={['*']} isLoading={false} role="OWNER">
          <div data-video-frame className="h-screen w-screen overflow-hidden">
            <PlatformShell embedded>
              <WeldChatCallProvider>
                <ChatLayout>{children}</ChatLayout>
              </WeldChatCallProvider>
            </PlatformShell>
          </div>
        </PermissionProvider>
      </PreviewInstalledAppsProvider>
    </PreviewModeProvider>
  );
}
