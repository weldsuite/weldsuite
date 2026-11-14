import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { RootErrorFallback } from '@/components/root-error-fallback';
import { ApiClientProvider } from '@/lib/api/api-provider';
import { getRealtimeUrl } from '@/lib/api/public-env';
import { QueryProvider } from '@/providers/query-provider';
import { ThemeProvider } from '@/providers/theme-provider';
import { I18nProvider, useI18n } from '@/lib/i18n/provider';
import { SettingsProvider } from '@/providers/settings-provider';
import { UnifiedNotificationProvider } from '@/contexts/unified-notification-context';
import { WorkspaceProvider } from '@/contexts/workspace-context';
import { PresenceProvider } from '@/contexts/presence-context';
import { TeamMemberPanelProvider } from '@/contexts/team-member-panel-context';
import { AppShellClient } from '@/components/app-shell-client';
import { PreferencesSync } from '@/components/preferences-sync';
import { AccessibilityBridge } from '@/components/layout/accessibility-bridge';
import { PrivateFilesAccess } from '@/components/private-files-access';
import { Toaster } from '@weldsuite/ui/components/sonner';
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RealtimeProvider, useRealtimeSync } from '@weldsuite/realtime/react';
import { PlatformPermissionProvider } from '@/providers/permission-provider';
import { useAuth } from '@/lib/auth';
import { platformSyncMap } from '@/lib/realtime/sync-map';
import { createBrowserCursorStore } from '@/lib/realtime/cursor-store';
import { useDesktopAuthHandler } from '@/hooks/use-desktop-auth';
import { DesktopSourcePicker } from '@/components/desktop/desktop-source-picker';
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

function DesktopAuthBridge() {
  const { t, format } = useI18n();
  useDesktopAuthHandler({
    onSuccess: () => {
      window.location.href = '/';
    },
    onError: (message) => {
      toast.error(format(t.common.desktopSignInFailed, { message }));
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

/**
 * The realtime socket belongs to a signed-in member with a workspace selected:
 * its token is scoped to that workspace, so on the sign-in, callback,
 * workspace-picker and onboarding routes there is nothing to connect with.
 * There the provider gets an empty URL and keeps no client (it stays mounted,
 * so the app below is not remounted when the workspace arrives). `connectionKey`
 * reconnects on a workspace switch. An empty URL is also what a deployment
 * without realtime resolves to.
 */
function RealtimeProviderWrapper({ children }: Readonly<{ children: React.ReactNode }>) {
  const { getToken, isSignedIn, orgId } = useAuth();
  const stableGetToken = useCallback(async () => (await getToken()) || '', [getToken]);
  const active = Boolean(isSignedIn && orgId);
  // Cursor store is scoped per-workspace so switching orgs starts a fresh replay window.
  const cursorStore = createBrowserCursorStore(orgId || 'no-org');
  return (
    <RealtimeProvider
      url={active ? getRealtimeUrl() : ''}
      getToken={stableGetToken}
      cursorStore={cursorStore}
      connectionKey={orgId || ''}
    >
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
            <AccessibilityBridge>
              <SettingsProvider>
                {/* Realtime must wrap the notification providers: the bell's
                    live `notification.<userId>` subscription (useTopic) reads
                    the workspace client from this context and silently gets
                    null when mounted above it. */}
                <RealtimeProviderWrapper>
                  <UnifiedNotificationProvider>
                    <WorkspaceProvider>
                      <PlatformPermissionProvider>
                        <PresenceProvider>
                          <TeamMemberPanelProvider>
                            {/* Live entity sync: useRealtimeSync only.
                                PlatformEventsProvider / useRealtimeQuerySync
                                / dataEvents.initializeRealtimeBridge were
                                stubs — removed in Phase 9. */}
                            <RealtimeSyncBridge />
                            <DesktopAuthBridge />
                            <PrivateFilesAccess />
                            {/* Must stay mounted for the whole session: the
                                shell denies screen-share requests whenever no
                                picker is registered. */}
                            <DesktopSourcePicker />
                            <AppShellClient>
                              <Outlet />
                            </AppShellClient>
                            <Toaster />
                          </TeamMemberPanelProvider>
                        </PresenceProvider>
                      </PlatformPermissionProvider>
                    </WorkspaceProvider>
                  </UnifiedNotificationProvider>
                </RealtimeProviderWrapper>
              </SettingsProvider>
            </AccessibilityBridge>
          </I18nProvider>
        </ThemeProvider>
      </QueryProvider>
    </ApiClientProvider>
  );
}
