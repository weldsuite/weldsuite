import { ClerkProvider, ClerkLoaded, useOrganizationList } from '@clerk/expo';
import { DefaultTheme, ThemeProvider as NavigationThemeProvider } from 'expo-router/react-navigation';
import { Observe, ObserveRoot, useObserve } from 'expo-observe';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { View, ActivityIndicator, Text, TouchableOpacity, Linking } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import * as SplashScreen from 'expo-splash-screen';
import 'react-native-reanimated';

import { hideAppSplash } from '@/utils/splash';

import { tokenCache } from '@clerk/expo/token-cache';
import { ClerkAuthProvider, useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { ThemeProvider, useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { ToastProvider } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { AnalyticsProvider } from '@weldsuite/mobile-ui/contexts/AnalyticsContext';
import { WorkspaceProvider } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { InstalledAppsProvider } from '@weldsuite/mobile-ui/contexts/InstalledAppsContext';
import { ErrorBoundary } from '@weldsuite/mobile-ui/components/ErrorBoundary';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';

import { BRAND } from '@/lib/brand';
import { NotificationProvider } from '@/contexts/NotificationContext';
import { CallProvider } from '@/contexts/CallContext';
import { IncomingCallModal } from '@/components/call/IncomingCallModal';
import { CallHost, CallInsetContainer } from '@/components/call/CallHost';
import { RealtimeProvider } from '@/providers/realtime-provider';
import { appApi, setAppApiTokenGetter } from '@/services/app-api';
import { useUpdateGate } from '@/hooks/useUpdateGate';

// Must run before any screen mounts — enables per-route TTR/TTI in Observe.
Observe.configure({
  integrations: { 'expo-router': true },
});

SplashScreen.preventAutoHideAsync().catch(() => {});

const CLERK_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

if (!CLERK_KEY) {
  console.error('Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY — auth will not work');
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoading, getCredentials, organizationId, signOut } = useClerkAuth();
  const { markInteractive } = useObserve();
  const router = useRouter();
  const segments = useSegments();
  const { colors } = useTheme();
  const { setActive, userMemberships, isLoaded: isOrgListLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  // Track whether org selection has been resolved
  const [orgReady, setOrgReady] = useState(false);

  // Auto-select first org or confirm no orgs exist
  useEffect(() => {
    if (!user) {
      setOrgReady(false);
      return;
    }
    if (!isOrgListLoaded) return;

    // Already has an active org
    if (organizationId) {
      setOrgReady(true);
      return;
    }

    // Has memberships but no active org — select the first one
    if (userMemberships?.data && userMemberships.data.length > 0 && setActive) {
      // setActive is async: if it rejects (flaky network / token refresh) we must
      // still resolve orgReady, otherwise the app hangs forever on the splash.
      // On success, organizationId updates and this effect re-runs to confirm.
      setActive({ organization: userMemberships.data[0].organization.id }).catch((err) => {
        console.warn('[WeldChat] setActive failed, falling through:', err);
        setOrgReady(true);
      });
      return;
    }

    // Org list loaded, data is an array, but empty — truly no workspace
    if (userMemberships?.data && userMemberships.data.length === 0) {
      setOrgReady(true);
    }
  }, [user, isOrgListLoaded, organizationId, userMemberships?.data?.length, setActive, userMemberships.data]);

  // Wire the app-api token getter during render (not in an effect) so it is set
  // BEFORE the child tab screens mount and fire their first data load. Effects
  // run children-first, so an effect here would wire the getter only AFTER a
  // focused screen already called the API with the default `() => null` getter,
  // throwing "Authentication required" on the first load. The assignment is an
  // idempotent module-level write and always closes over the freshest token.
  if (user) {
    setAppApiTokenGetter(async () => (await getCredentials())?.accessToken ?? null);
  } else {
    setAppApiTokenGetter(null);
  }

  // Hide the native splash as soon as Clerk has resolved auth. The AuthGuard
  // renders its own loading spinner below, so org selection (which can race or
  // fail) must NOT keep the native splash up — otherwise the app appears to
  // "fail to start". A hard timeout is a last-resort safety net.
  useEffect(() => {
    if (!isLoading) {
      hideAppSplash();
    }
    const safety = setTimeout(() => hideAppSplash(), 5000);
    return () => clearTimeout(safety);
  }, [isLoading]);

  const showNoWorkspace = Boolean(user && orgReady && isOrgListLoaded && !organizationId);

  useEffect(() => {
    if (showNoWorkspace) {
      hideAppSplash();
      markInteractive();
    }
  }, [showNoWorkspace, markInteractive]);

  // Route guard
  useEffect(() => {
    if (isLoading) return;
    const inAuth = segments[0] === 'authorisation';

    if (!user && !inAuth) {
      router.replace('/authorisation');
      return;
    }

    if (user && !orgReady) return;

    if (user && inAuth) {
      router.replace('/(tabs)');
    }
  }, [user, isLoading, orgReady, segments, router]);

  if (isLoading || (user && !isOrgListLoaded) || (user && !orgReady)) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator size="large" color={BRAND} />
      </View>
    );
  }

  // User signed in but has no organizations
  if (user && !organizationId) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background, paddingHorizontal: 32 }}>
        <EmptyState
          title="No Workspace Found"
          description="You need a WeldSuite workspace to use WeldChat. Create one on the web to get started."
        />
        <View style={{ marginTop: 8, width: '100%', maxWidth: 320, gap: 12 }}>
          <Button title="Create Workspace" onPress={() => Linking.openURL('https://app.weldsuite.org')} />
          <TouchableOpacity style={{ paddingVertical: 8, alignItems: 'center' }} onPress={() => signOut()}>
            <Text style={{ color: BRAND, fontSize: 15 }}>Sign in with a different account</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return <>{children}</>;
}

const workspaceApi = {
  // app-api has no single "current workspace" endpoint; returning a failure
  // lets WorkspaceProvider fall back to the active Clerk org (the source of
  // truth for which workspace is current).
  getCurrentWorkspace: async () => ({ success: false as const }),
  getUserWorkspaces: async () => {
    try {
      const { data: workspaces } = await appApi.workspaces.list();
      // WorkspaceProvider expects WorkspaceWithMembership[]. WorkspaceSummary.id
      // is the Clerk org id (what setActive/switchWorkspace expects).
      const mapped = (workspaces ?? []).map((w) => ({
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
      const { data: codes } = await appApi.dashboard.installedApps();
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

function AppStack() {
  const { theme, colors } = useTheme();
  const navigationTheme = {
    ...DefaultTheme,
    dark: theme === 'dark',
    colors: {
      ...DefaultTheme.colors,
      primary: colors.text,
      background: colors.background,
      card: colors.cardBackground,
      text: colors.text,
      border: colors.divider,
      notification: colors.text,
    },
  };

  return (
    <ToastProvider>
      <NotificationProvider>
        <InstalledAppsProvider api={installedAppsApi}>
          <WorkspaceProvider api={workspaceApi}>
            <NavigationThemeProvider value={navigationTheme}>
              <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
              <AuthGuard>
                <RealtimeProvider>
                  <CallProvider>
                    <CallInsetContainer>
                      <Stack
                        screenOptions={{
                          headerShown: false,
                          contentStyle: { backgroundColor: colors.background },
                          animation: 'slide_from_right',
                        }}
                      >
                        <Stack.Screen name="(tabs)" />
                        <Stack.Screen name="sso-callback" />
                        <Stack.Screen name="authorisation/index" />
                        <Stack.Screen
                          name="channel/[channelId]"
                          options={{ gestureEnabled: true, fullScreenGestureEnabled: true }}
                        />
                        <Stack.Screen
                          name="dm/[channelId]"
                          options={{ gestureEnabled: true, fullScreenGestureEnabled: true }}
                        />
                        <Stack.Screen
                          name="thread/[messageId]"
                          options={{ headerShown: true, title: 'Thread' }}
                        />
                        <Stack.Screen
                          name="new-channel"
                          options={{ headerShown: false, presentation: 'modal' }}
                        />
                        <Stack.Screen
                          name="new-dm"
                          options={{ headerShown: false, presentation: 'modal' }}
                        />
                        <Stack.Screen name="search" />
                        <Stack.Screen name="settings" />
                        <Stack.Screen name="profile" />
                        <Stack.Screen name="huddles" />
                        <Stack.Screen name="later" />
                        <Stack.Screen name="drafts" />
                        <Stack.Screen
                          name="call-room"
                          options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade' }}
                        />
                      </Stack>
                    </CallInsetContainer>
                    <CallHost />
                    <IncomingCallModal />
                  </CallProvider>
                </RealtimeProvider>
              </AuthGuard>
            </NavigationThemeProvider>
          </WorkspaceProvider>
        </InstalledAppsProvider>
      </NotificationProvider>
    </ToastProvider>
  );
}

function AuthenticatedApp() {
  return (
    <ClerkAuthProvider>
      <AnalyticsProvider>
        <ThemeProvider>
          <AppStack />
        </ThemeProvider>
      </AnalyticsProvider>
    </ClerkAuthProvider>
  );
}

function RootLayout() {
  // First-launch OTA gate: check for and apply the latest update before the app
  // renders, so first-time installers never see the stale embedded bundle.
  const checkingUpdate = useUpdateGate();

  useEffect(() => {
    const safety = setTimeout(() => hideAppSplash(), 5000);
    return () => clearTimeout(safety);
  }, []);

  if (checkingUpdate) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFFFFF' }}>
          <ActivityIndicator size="large" color={BRAND} />
        </View>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <ErrorBoundary>
            <ClerkProvider publishableKey={CLERK_KEY || ''} tokenCache={tokenCache}>
              <ClerkLoaded>
                <AuthenticatedApp />
              </ClerkLoaded>
            </ClerkProvider>
          </ErrorBoundary>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default ObserveRoot.wrap(RootLayout);
