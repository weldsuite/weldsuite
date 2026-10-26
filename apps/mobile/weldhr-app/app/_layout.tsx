import { ClerkProvider, ClerkLoaded, useOrganizationList } from '@clerk/expo';
import { DefaultTheme, ThemeProvider as NavigationThemeProvider } from 'expo-router/react-navigation';
import { Observe, ObserveRoot } from 'expo-observe';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { View, ActivityIndicator, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import * as SplashScreen from 'expo-splash-screen';
import 'react-native-reanimated';

import { hideAppSplash } from '@/utils/splash';

import { tokenCache } from '@clerk/expo/token-cache';
import { ClerkAuthProvider, useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { ThemeProvider, useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { ToastProvider } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { AnalyticsProvider } from '@weldsuite/mobile-ui/contexts/AnalyticsContext';
import { ErrorBoundary } from '@weldsuite/mobile-ui/components/ErrorBoundary';
import { WorkspaceProvider } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { InstalledAppsProvider } from '@weldsuite/mobile-ui/contexts/InstalledAppsContext';

import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { queryClient } from '@/lib/query-client';

import { appApi, setAppApiTokenGetter } from '@/services/app-api';
import { NotificationProvider } from '@/contexts/NotificationContext';
import { AppLockProvider } from '@/contexts/AppLockContext';
import { RealtimeProvider } from '@/providers/realtime-provider';
import { RealtimeSyncBridge } from '@/providers/realtime-sync-bridge';
import { I18nProvider, useI18n, usePersistedLanguage } from '@/lib/i18n';
import { BRAND } from '@/constants/brand';

// Must run before any screen mounts — enables per-route TTR/TTI in Observe.
Observe.configure({
  integrations: { 'expo-router': true },
});

SplashScreen.preventAutoHideAsync().catch(() => {});

const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

if (!CLERK_PUBLISHABLE_KEY) {
  console.error('Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY — auth will not work');
}

function AuthGuard({ children }: Readonly<{ children: React.ReactNode }>) {
  const { user, isLoading, getCredentials, organizationId } = useClerkAuth();
  const { t } = useI18n();
  const router = useRouter();
  const segments = useSegments();
  const { setActive, userMemberships, isLoaded: isOrgListLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  // Auto-select first org if user has memberships but none active
  useEffect(() => {
    if (user && !organizationId && isOrgListLoaded && setActive && userMemberships?.data?.length) {
      setActive({ organization: userMemberships.data[0].organization.id });
    }
  }, [user, organizationId, isOrgListLoaded, setActive, userMemberships?.data]);

  // The cache holds payslips, balances and permissions, and its keys are not
  // per user or per workspace. Drop it whenever the signed-in user changes,
  // sign-out and an expired session included, so the next person on a shared
  // phone starts empty. Sign-out passes through "no user" (the sign-in
  // screen), so the clear lands before anyone else's screens mount. Switching
  // workspace (Home's workspace menu) resets it instead: the open screens
  // load again from the new workspace, and the last one's data never shows.
  const queryClient = useQueryClient();
  const lastUserId = useRef<string | null | undefined>(undefined);
  const lastOrgId = useRef<string | null>(null);
  useEffect(() => {
    const userId = user?.id ?? null;
    const orgId = organizationId ?? null;
    if (lastUserId.current !== undefined && lastUserId.current !== userId) queryClient.clear();
    else if (lastOrgId.current && orgId && lastOrgId.current !== orgId) void queryClient.resetQueries();
    lastUserId.current = userId;
    lastOrgId.current = orgId;
  }, [user?.id, organizationId, queryClient]);

  // Wire the app-api token getter SYNCHRONOUSLY during render so it is set
  // BEFORE the child screens mount and fire their first data load. Effects
  // run children-first, so an effect here would wire the getter only AFTER a
  // focused screen already called the API with the default `() => null`
  // getter. The assignment is an idempotent module-level write and always
  // closes over the freshest token.
  if (user) {
    setAppApiTokenGetter(async () => (await getCredentials())?.accessToken ?? null);
  } else {
    setAppApiTokenGetter(null);
  }

  // Route guard
  useEffect(() => {
    if (isLoading) return;
    if (user && !isOrgListLoaded) return;

    const inAuthGroup = segments[0] === 'authorisation';
    const inNoWorkspace = segments[0] === 'no-workspace';

    if (!user && !inAuthGroup) {
      router.replace('/authorisation');
      return;
    }

    if (user) {
      const hasOrg = userMemberships?.data && userMemberships.data.length > 0;

      if (!hasOrg && !inNoWorkspace) {
        router.replace('/no-workspace');
        return;
      }

      if (hasOrg && (inAuthGroup || inNoWorkspace)) {
        router.replace('/(tabs)');
      }
    }
  }, [user, isLoading, isOrgListLoaded, userMemberships?.data, segments, router]);

  if (isLoading || (user && !isOrgListLoaded)) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <ActivityIndicator size="large" color={BRAND} />
        <Text style={{ marginTop: 16, color: '#666' }}>{t.common.loading}</Text>
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
    colors: { ...DefaultTheme.colors, primary: colors.text, background: colors.background, card: colors.cardBackground, text: colors.text, border: colors.divider, notification: colors.text },
  };

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <NotificationProvider>
          <InstalledAppsProvider api={installedAppsApi}>
            <WorkspaceProvider api={workspaceApi}>
              <NavigationThemeProvider value={navigationTheme}>
                <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
                <AuthGuard>
                  <AppLockProvider>
                    <RealtimeProvider>
                      <RealtimeSyncBridge />
                      <Stack screenOptions={{ headerShown: false }}>
                        <Stack.Screen name="authorisation" />
                        <Stack.Screen name="sso-callback" />
                        <Stack.Screen name="no-workspace" options={{ animation: 'fade', animationDuration: 200, gestureEnabled: false }} />
                        <Stack.Screen name="(tabs)" options={{ animation: 'fade', animationDuration: 150 }} />
                        <Stack.Screen name="leave/new" options={{ presentation: 'modal' }} />
                        <Stack.Screen name="expense/new" options={{ presentation: 'modal' }} />
                        <Stack.Screen name="sick" options={{ presentation: 'modal' }} />
                        <Stack.Screen name="shift/new" options={{ presentation: 'modal' }} />
                        <Stack.Screen name="profile" />
                        <Stack.Screen name="shift/[id]" />
                        <Stack.Screen name="leave/[id]" />
                        <Stack.Screen name="sick/[id]" />
                        <Stack.Screen name="shift-request/[id]" />
                        <Stack.Screen name="pay" />
                        <Stack.Screen name="tasks" />
                        <Stack.Screen name="reviews" />
                        <Stack.Screen name="directory" />
                        <Stack.Screen name="employee/[id]" />
                      </Stack>
                    </RealtimeProvider>
                  </AppLockProvider>
                </AuthGuard>
              </NavigationThemeProvider>
            </WorkspaceProvider>
          </InstalledAppsProvider>
        </NotificationProvider>
      </ToastProvider>
    </QueryClientProvider>
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
  const { ready, language } = usePersistedLanguage();

  useEffect(() => {
    const safety = setTimeout(() => hideAppSplash(), 5000);
    return () => clearTimeout(safety);
  }, []);

  // The saved language is read from storage in a few milliseconds; waiting for
  // it keeps a Dutch user from seeing the first screen flash in English.
  if (!ready) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <ActivityIndicator size="large" color={BRAND} />
      </View>
    );
  }

  return (
    <I18nProvider initialLanguage={language}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardProvider>
          <ErrorBoundary>
            {/* We only use Clerk's JS auth flows (no native AuthView/UserButton). Native
                client sync races browser SSO on Android and signs users out again. */}
            <ClerkProvider
              publishableKey={CLERK_PUBLISHABLE_KEY || ''}
              tokenCache={tokenCache}
              __experimental_disableNativeClientSync
            >
              <ClerkLoaded>
                <AuthenticatedApp />
              </ClerkLoaded>
            </ClerkProvider>
          </ErrorBoundary>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </I18nProvider>
  );
}

export default ObserveRoot.wrap(RootLayout);
