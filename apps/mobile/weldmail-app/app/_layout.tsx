import { AuthLoaded, AuthLoading, AuthProvider, useOrganizationList } from '@weldsuite/mobile-platform/auth';
import { isFeatureAvailable } from '@weldsuite/mobile-platform/edition';
import { DefaultTheme, ThemeProvider as NavigationThemeProvider } from 'expo-router/react-navigation';
import { Observe, ObserveRoot } from 'expo-observe';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import * as SplashScreen from 'expo-splash-screen';
import 'react-native-reanimated';
// Defines + registers the background notification task; must load at startup.
import '@/utils/notification-tasks';

import { hideAppSplash } from '@/utils/splash';

import { AuthSessionProvider, useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';
import { ServerRuntimeGate } from '@weldsuite/mobile-ui/components/ServerRuntimeGate';
import { ThemeProvider, useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { ToastProvider } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { AnalyticsProvider } from '@weldsuite/mobile-ui/contexts/AnalyticsContext';
import { ErrorBoundary } from '@weldsuite/mobile-ui/components/ErrorBoundary';
import { WorkspaceProvider } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { InstalledAppsProvider } from '@weldsuite/mobile-ui/contexts/InstalledAppsContext';

import { appApi, appApiClient, setAppApiTokenGetter } from '@/services/app-api';
import { personalApi, setPersonalApiTokenGetter } from '@/services/personal-api';
import { NotificationProvider } from '@/contexts/NotificationContext';
import { PermissionProvider } from '@/contexts/PermissionContext';
import { MailProvider, useMail } from '@/contexts/MailContext';
import { PinnedMessagesProvider } from '@/contexts/PinnedMessagesContext';
import { ComposeOverlayProvider } from '@/contexts/ComposeOverlayContext';
import { RealtimeProvider } from '@/providers/realtime-provider';
import { NetworkProvider } from '@/contexts/NetworkContext';
import { OfflineBanner } from '@/components/OfflineBanner';
import { OutboxFlusher } from '@/components/OutboxFlusher';
import { useMailRealtime } from '@/hooks/useMailRealtime';
import { usePersonalMailRealtime } from '@/hooks/usePersonalMailRealtime';
import { useMailEntityRealtime } from '@/hooks/useMailEntityRealtime';
import { BRAND } from '@/lib/brand';
import { passkeys } from '@/lib/clerk-passkeys';
import { language } from '@/lib/i18n';
import { registerServerDataCleaner } from '@/lib/offline/clear-server-data';
import { APP, BUILD } from '@/lib/server';

// Must run before any screen mounts — enables per-route TTR/TTI in Observe.
Observe.configure({
  integrations: { 'expo-router': true },
});

// Keep the native splash until the inbox or an opened email has something to
// paint — avoids a labeled loader flash on cold start / notification tap.
SplashScreen.preventAutoHideAsync().catch(() => {});

// Switching server clears the offline cache, outbox and the other per-server mail data.
registerServerDataCleaner();

/**
 * Where a person without a workspace goes: their inbox, or claiming a free
 * address. Free @weldmail addresses are a WeldSuite cloud feature: where the
 * server has none there is nothing to claim, so without a mailbox they land
 * on `/no-workspace`.
 */
function personalRoute(hasMail: boolean): '/' | '/claim-address' | '/no-workspace' {
  if (hasMail) return '/';
  return isFeatureAvailable('mail-free-addresses') ? '/claim-address' : '/no-workspace';
}

function AuthGuard({ children }: Readonly<{ children: React.ReactNode }>) {
  const { user, isLoading, getCredentials, organizationId } = useAuthSession();
  const router = useRouter();
  const segments = useSegments();
  const { setActive, userMemberships, isLoaded: isOrgListLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  const membershipsLoading = userMemberships?.isLoading ?? true;
  const membershipCount = userMemberships?.data?.length ?? 0;

  // Wire token getters during render (not in an effect) so the first fetch
  // already has a session token. Effects run children-first.
  if (user) {
    const getAccessToken = async () => {
      const credentials = await getCredentials();
      return credentials?.accessToken || null;
    };
    setAppApiTokenGetter(getAccessToken);
    setPersonalApiTokenGetter(getAccessToken);
  } else {
    setAppApiTokenGetter(null);
    setPersonalApiTokenGetter(null);
  }

  useEffect(() => {
    if (
      user &&
      !organizationId &&
      isOrgListLoaded &&
      !membershipsLoading &&
      setActive &&
      membershipCount > 0 &&
      userMemberships?.data
    ) {
      setActive({ organization: userMemberships.data[0].organization.id });
    }
  }, [user, organizationId, isOrgListLoaded, membershipsLoading, membershipCount, setActive, userMemberships?.data]);

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === 'authorisation';
    const inNoWorkspace = segments[0] === 'no-workspace';
    const inClaimAddress = segments[0] === 'claim-address';
    const inSsoCallback = segments[0] === 'sso-callback';

    if (!user) {
      if (!inAuthGroup && !inSsoCallback) router.replace('/authorisation');
      return;
    }

    if (user && !isOrgListLoaded) return;
    // Wait for Clerk to finish fetching memberships before making routing decisions.
    if (user && membershipsLoading) return;

    const hasOrg = membershipCount > 0 || !!organizationId;

    // Team / workspace path. Personal mail is loaded alongside workspace
    // mail in MailContext — org membership no longer excludes a personal inbox.
    // `/claim-address` is the no-org onboarding screen; workspace users add a
    // personal address from Add account instead.
    if (hasOrg) {
      if (inAuthGroup || inNoWorkspace || inClaimAddress || inSsoCallback) {
        router.replace('/');
      }
      return;
    }

    // Personal path — no org memberships: onboard via personal-api, then
    // claim an address or enter the inbox. Fall back to /no-workspace only
    // if personal onboard fails.
    let cancelled = false;

    async function routePersonal() {
      try {
        await personalApi.onboard();
        const { data: me } = await personalApi.me();
        if (cancelled) return;

        const target = personalRoute((me.mailAccounts?.length ?? 0) > 0);
        if (target !== '/') {
          if (segments[0] !== target.slice(1)) router.replace(target);
          return;
        }
        if (inAuthGroup || inNoWorkspace || inClaimAddress || inSsoCallback) {
          router.replace('/');
        }
      } catch {
        if (cancelled) return;
        if (!inNoWorkspace && !inClaimAddress) {
          router.replace('/no-workspace');
        }
      }
    }

    void routePersonal();
    return () => {
      cancelled = true;
    };
  }, [user, isLoading, isOrgListLoaded, membershipsLoading, membershipCount, organizationId, segments, router]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={BRAND} />
      </View>
    );
  }

  return <>{children}</>;
}

const workspaceApi = {
  // app-api has no single "current workspace" endpoint; returning a failure
  // lets WorkspaceProvider fall back to the active Clerk org (the source of
  // truth for which workspace is current).
  getCurrentWorkspace: () => Promise.resolve({ success: false as const }),
  getUserWorkspaces: async () => {
    try {
      const { data: workspaces } = await appApi.workspaces.list();
      // WorkspaceProvider expects WorkspaceWithMembership[]. WorkspaceSummary.id
      // is the Clerk org id (what setActive/switchWorkspace expects).
      const mapped = workspaces.map((w) => ({
        id: w.id,
        clerkOrgId: w.id,
        name: w.name,
        slug: w.slug,
        imageUrl: w.imageUrl ?? undefined,
        isActive: true,
        role: w.role,
        membershipStatus: 'active',
      }));
      return { success: true as const, data: mapped };
    } catch {
      return { success: false as const, data: [] };
    }
  },
};

const installedAppsApi = {
  getInstalledApps: async () => {
    try {
      // Returns { data: string[] } of installed app codes — map to InstalledApp[].
      const { data: codes } = await appApiClient.get<{ data: string[] }>('/dashboard/installed-apps');
      return (codes ?? []).map((code, i) => ({
        id: code,
        workspaceId: '',
        appCode: code,
        name: code,
        status: 'active',
        displayOrder: i,
      }));
    } catch {
      return [];
    }
  },
};

/**
 * Mounts mail realtime hooks. Must live inside both RealtimeProvider
 * (for the WorkspaceClient context) and MailProvider (for refreshMail).
 * Returns null — purely a side-effect component.
 *
 * Dual listen: personal `mail.{userId}` / mail:new (toast + inbox) and
 * hub entity topics (email + campaign/signature/rule/template) for shared
 * mailboxes. Full useRealtimeSync trails in Phase 8 (no QueryClient yet).
 */
function MailRealtimeWatcher() {
  const { refreshMail } = useMail();
  useMailRealtime();
  // Personal addresses publish to their own per-user hub, which the org-keyed
  // RealtimeProvider socket can't reach; this opens the second connection.
  usePersonalMailRealtime();
  useMailEntityRealtime({
    onInvalidate: () => {
      refreshMail();
    },
  });
  return null;
}

function AppStack() {
  const { theme, colors } = useTheme();
  const navigationTheme = {
    ...DefaultTheme,
    dark: theme === 'dark',
    colors: { ...DefaultTheme.colors, primary: colors.text, background: colors.background, card: colors.cardBackground, text: colors.text, border: colors.divider, notification: colors.text },
  };

  return (
    <NetworkProvider>
    <RealtimeProvider>
    <ToastProvider>
      <InstalledAppsProvider api={installedAppsApi}>
        <WorkspaceProvider api={workspaceApi}>
          <PermissionProvider>
            <MailProvider>
              {/* Inside MailProvider: a notification tap switches the mailbox to
                  the account the email arrived in before opening it. */}
              <NotificationProvider>
              <MailRealtimeWatcher />
              <PinnedMessagesProvider>
              <NavigationThemeProvider value={navigationTheme}>
                <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
                <OfflineBanner />
                <OutboxFlusher />
                <AuthGuard>
                  <ComposeOverlayProvider>
                  <Stack screenOptions={{ headerShown: false }}>
                    <Stack.Screen name="authorisation" />
                    <Stack.Screen name="no-workspace" />
                    <Stack.Screen name="claim-address" />
                    <Stack.Screen name="index" options={{ headerShown: false }} />
                    <Stack.Screen
                      name="[id]"
                      options={({ route }) => ({
                        headerShown: false,
                        presentation: 'card',
                        gestureEnabled: true,
                        gestureDirection: 'horizontal',
                        fullScreenGestureEnabled: true,
                        // Notification opens skip the slide so the first painted
                        // frame is the email, like Gmail/Outlook.
                        animation: (route.params as { fromNotification?: string } | undefined)
                          ?.fromNotification
                          ? 'none'
                          : 'slide_from_right',
                      })}
                    />
                    <Stack.Screen
                      name="search"
                      options={{
                        headerShown: false,
                        presentation: 'card',
                        animation: 'fade',
                        animationDuration: 150,
                      }}
                    />
                    <Stack.Screen
                      name="settings"
                      options={{
                        animation: 'slide_from_right',
                        gestureEnabled: true,
                        gestureDirection: 'horizontal',
                      }}
                    />
                    <Stack.Screen
                      name="subscriptions"
                      options={{
                        animation: 'slide_from_right',
                        gestureEnabled: true,
                        gestureDirection: 'horizontal',
                      }}
                    />
                    <Stack.Screen
                      name="add-account"
                      options={{
                        headerShown: false,
                        presentation: 'modal',
                        animation: 'slide_from_bottom',
                      }}
                    />
                    <Stack.Screen
                      name="contact/[id]"
                      options={{
                        headerShown: false,
                        presentation: 'card',
                        animation: 'slide_from_right',
                        gestureEnabled: true,
                        gestureDirection: 'horizontal',
                        fullScreenGestureEnabled: true,
                      }}
                    />
                  </Stack>
                  </ComposeOverlayProvider>
                </AuthGuard>
              </NavigationThemeProvider>
              </PinnedMessagesProvider>
              </NotificationProvider>
            </MailProvider>
          </PermissionProvider>
        </WorkspaceProvider>
      </InstalledAppsProvider>
    </ToastProvider>
    </RealtimeProvider>
    </NetworkProvider>
  );
}

function AuthenticatedApp() {
  return (
    <AuthSessionProvider>
      <AnalyticsProvider>
        <ThemeProvider>
          <AppStack />
        </ThemeProvider>
      </AnalyticsProvider>
    </AuthSessionProvider>
  );
}

function RootLayout() {
  useEffect(() => {
    const safety = setTimeout(() => hideAppSplash(), 5000);
    const early = setTimeout(() => hideAppSplash(), 1500);
    return () => {
      clearTimeout(safety);
      clearTimeout(early);
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ErrorBoundary>
          {/* Which server (WeldSuite cloud, EU, self-hosted) and who signs people
              in there: Clerk on cloud, the server's OIDC provider elsewhere. */}
          <ServerRuntimeGate
            app={APP}
            build={BUILD}
            language={language}
            accentColor={BRAND}
            onFailed={hideAppSplash}
          >
            <AuthProvider clerk={{ passkeys }}>
              <AuthLoading>
                {null}
              </AuthLoading>
              <AuthLoaded>
                <AuthenticatedApp />
              </AuthLoaded>
            </AuthProvider>
          </ServerRuntimeGate>
        </ErrorBoundary>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

export default ObserveRoot.wrap(RootLayout);
