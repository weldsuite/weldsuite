import { AuthLoaded, AuthProvider, useOrganizationList } from '@weldsuite/mobile-platform/auth';
import { DefaultTheme, ThemeProvider as NavigationThemeProvider } from 'expo-router/react-navigation';
import { Observe, ObserveRoot } from 'expo-observe';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View, ActivityIndicator, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import * as SplashScreen from 'expo-splash-screen';
import 'react-native-reanimated';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { hideAppSplash } from '@/utils/splash';

import { AuthSessionProvider, useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';
import { ServerRuntimeGate } from '@weldsuite/mobile-ui/components/ServerRuntimeGate';
import { ThemeProvider, useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { ToastProvider } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { AnalyticsProvider } from '@weldsuite/mobile-ui/contexts/AnalyticsContext';
import { ErrorBoundary } from '@weldsuite/mobile-ui/components/ErrorBoundary';
import { WorkspaceProvider } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';

import { appApi, setAppApiTokenGetter } from '@/services/app-api';
import { personalApi, setPersonalApiTokenGetter } from '@/services/personal-api';
import { NotificationProvider } from '@/contexts/NotificationContext';
import { BRAND } from '@/lib/brand';
import { APP, BUILD } from '@/lib/server';
import { hydrateCalendarVisibility } from '@/lib/calendar-visibility';
import { I18nProvider, useI18n, usePersistedLanguage } from '@/lib/i18n';

// Must run before any screen mounts — enables per-route TTR/TTI in Observe.
Observe.configure({
  integrations: { 'expo-router': true },
});

SplashScreen.preventAutoHideAsync().catch(() => {});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function AuthGuard({ children }: Readonly<{ children: React.ReactNode }>) {
  const { user, isLoading, getCredentials, organizationId } = useAuthSession();
  const router = useRouter();
  const segments = useSegments();
  const { t } = useI18n();
  const { setActive, userMemberships, isLoaded: isOrgListLoaded } = useOrganizationList({
    userMemberships: true,
  });

  const membershipsLoading = userMemberships?.isLoading ?? true;
  const membershipCount = userMemberships?.data?.length ?? 0;

  // Wire token getters during render (not in an effect) so the first fetch
  // already has a session token. Effects run children-first.
  if (user) {
    const getAccessToken = async () => (await getCredentials())?.accessToken ?? null;
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
  }, [
    user,
    organizationId,
    isOrgListLoaded,
    membershipsLoading,
    membershipCount,
    setActive,
    userMemberships?.data,
  ]);

  useEffect(() => {
    if (isLoading) return;
    if (user && !isOrgListLoaded) return;
    if (user && membershipsLoading) return;

    const inAuthGroup = segments[0] === 'authorisation';
    const inNoWorkspace = segments[0] === 'no-workspace';
    const inSsoCallback = segments[0] === 'sso-callback';

    if (!user) {
      if (!inAuthGroup && !inSsoCallback) router.replace('/authorisation');
      return;
    }

    const hasOrg = membershipCount > 0 || !!organizationId;

    // Team / workspace path. Personal calendars are loaded alongside workspace
    // calendars in the merged agenda — org membership no longer excludes a
    // personal calendar.
    if (hasOrg) {
      void personalApi
        .onboard()
        .then(() => personalApi.calendars.ensureDefault())
        .catch(() => {});
      if (inAuthGroup || inNoWorkspace || inSsoCallback) {
        router.replace('/(tabs)');
      }
      return;
    }

    // Personal path — no org memberships: onboard via personal-api, then enter
    // the tabs. Fall back to /no-workspace only if personal onboard fails.
    let cancelled = false;

    async function routePersonal() {
      try {
        await personalApi.onboard();
        await personalApi.calendars.ensureDefault();
        if (cancelled) return;
        if (inAuthGroup || inNoWorkspace || inSsoCallback) {
          router.replace('/(tabs)');
        }
      } catch {
        if (cancelled) return;
        if (!inNoWorkspace) router.replace('/no-workspace');
      }
    }

    void routePersonal();
    return () => {
      cancelled = true;
    };
  }, [
    user,
    isLoading,
    isOrgListLoaded,
    membershipsLoading,
    membershipCount,
    organizationId,
    segments,
    router,
  ]);

  if (isLoading || (user && !isOrgListLoaded) || (user && membershipsLoading)) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <ActivityIndicator size="large" color={BRAND} />
        <Text style={{ marginTop: 16, color: '#666' }}>{t.common.loading}</Text>
      </View>
    );
  }

  return <>{children}</>;
}

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
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WorkspaceProvider api={workspaceApi}>
          <NotificationProvider>
            <NavigationThemeProvider value={navigationTheme}>
              <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
              <AuthGuard>
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="authorisation" />
                  <Stack.Screen name="sso-callback" />
                  <Stack.Screen name="no-workspace" options={{ animation: 'fade' }} />
                  <Stack.Screen name="(tabs)" options={{ animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="settings" />
                  <Stack.Screen name="event/[eventId]" />
                  <Stack.Screen name="event/new" />
                  <Stack.Screen name="event/edit/[eventId]" />
                </Stack>
              </AuthGuard>
            </NavigationThemeProvider>
          </NotificationProvider>
        </WorkspaceProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

const workspaceApi = {
  getCurrentWorkspace: () => Promise.resolve({ success: false as const }),
  getUserWorkspaces: async () => {
    try {
      const { data: workspaces } = await appApi.workspaces.list();
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
  const { ready, language } = usePersistedLanguage();
  const updating = !ready;

  // Read the hidden-calendar set off AsyncStorage before the tabs mount, so
  // the agenda never paints the full set and then drops rows a frame later.
  useEffect(() => {
    void hydrateCalendarVisibility();
  }, []);

  useEffect(() => {
    const safety = setTimeout(() => hideAppSplash(), 5000);
    return () => clearTimeout(safety);
  }, []);

  if (updating) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <ActivityIndicator size="large" color={BRAND} />
        <Text style={{ marginTop: 16, color: '#666' }}>Updating…</Text>
      </View>
    );
  }

  return (
    <I18nProvider initialLanguage={language}>
      <SafeAreaProvider>
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
                <AuthProvider>
                  <AuthLoaded>
                    <AuthenticatedApp />
                  </AuthLoaded>
                </AuthProvider>
              </ServerRuntimeGate>
            </ErrorBoundary>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </SafeAreaProvider>
    </I18nProvider>
  );
}

export default ObserveRoot.wrap(RootLayout);
