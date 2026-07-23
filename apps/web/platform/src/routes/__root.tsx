import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { RootErrorFallback } from '@/components/root-error-fallback';
import { ApiClientProvider } from '@/lib/api/api-provider';
import { QueryProvider } from '@/providers/query-provider';
import { ThemeProvider } from '@/providers/theme-provider';
import { I18nProvider } from '@/lib/i18n/provider';
import { SettingsProvider } from '@/providers/settings-provider';
import { NotificationProvider } from '@/contexts/notification-context';
import { UnifiedNotificationProvider } from '@/contexts/unified-notification-context';
import { WorkspaceProvider } from '@/contexts/workspace-context';
import { PlatformEventsProvider } from '@/contexts/platform-events-context';
import { PresenceProvider } from '@/contexts/presence-context';
import { TeamMemberPanelProvider } from '@/contexts/team-member-panel-context';
import { AppShellClient } from '@/components/app-shell-client';
import { PreferencesSync } from '@/components/preferences-sync';
import { Toaster } from '@weldsuite/ui/components/sonner';
import { useRealtimeQuerySync } from '@/hooks/use-realtime-query-sync';
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RealtimeProvider, useRealtimeSync } from '@weldsuite/realtime/react';
import { PlatformPermissionProvider } from '@/providers/permission-provider';
import { useAuth } from '@clerk/clerk-react';
import { platformSyncMap } from '@/lib/realtime/sync-map';
import { createBrowserCursorStore } from '@/lib/realtime/cursor-store';
import { useDesktopAuthHandler } from '@/hooks/use-desktop-auth';
import { toast } from 'sonner';
// Side-effect import: registers every object panel with the registry. Must
// run before <ObjectPanelHost /> (mounted inside AppShellClient) renders.
import '@/components/objects';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  errorComponent: RootErrorFallback,
});

function RealtimeQuerySync() {
  useRealtimeQuerySync();
  return null;
}

function DesktopAuthBridge() {
  useDesktopAuthHandler({
    onSuccess: () => {
      window.location.href = '/';
    },
    onError: (message) => {
      toast.error(`Desktop sign-in failed: ${message}`);
    },
  });
  return null;
}

function RealtimeSyncBridge() {
  const { userId } = useAuth();
  const queryClient = useQueryClient();
  useRealtimeSync({
    queryClient,
    syncMap: platformSyncMap,
    currentUserId: userId || '',
  });
  return null;
}

const REALTIME_URL = import.meta.env.VITE_REALTIME_URL || 'ws://localhost:8790/ws';

function RealtimeProviderWrapper({ children }: { children: React.ReactNode }) {
  const { getToken, orgId } = useAuth();
  const stableGetToken = useCallback(async () => (await getToken()) || '', [getToken]);
  // Cursor store is scoped per-workspace so switching orgs starts a fresh
  // replay window. Falls back to a sentinel key on the rare "no org yet" path
  // (Clerk loads before the user picks an org); the cursor is harmless there.
  const cursorStore = createBrowserCursorStore(orgId || 'no-org');
  return (
    <RealtimeProvider url={REALTIME_URL} getToken={stableGetToken} cursorStore={cursorStore}>
      {children}
    </RealtimeProvider>
  );
}

function RootComponent() {
  return (
    <ApiClientProvider>
      <QueryProvider>
        <ThemeProvider>
          <I18nProvider>
            <PreferencesSync />
            <SettingsProvider>
              <NotificationProvider>
                <UnifiedNotificationProvider>
                  <WorkspaceProvider>
                    <PlatformPermissionProvider>
                      <RealtimeProviderWrapper>
                        <PlatformEventsProvider>
                          <PresenceProvider>
                            <TeamMemberPanelProvider>
                              <RealtimeQuerySync />
                              <RealtimeSyncBridge />
                              <DesktopAuthBridge />
                              <AppShellClient>
                                <Outlet />
                              </AppShellClient>
                              <Toaster />
                            </TeamMemberPanelProvider>
                          </PresenceProvider>
                        </PlatformEventsProvider>
                      </RealtimeProviderWrapper>
                    </PlatformPermissionProvider>
                  </WorkspaceProvider>
                </UnifiedNotificationProvider>
              </NotificationProvider>
            </SettingsProvider>
          </I18nProvider>
        </ThemeProvider>
      </QueryProvider>
    </ApiClientProvider>
  );
}
