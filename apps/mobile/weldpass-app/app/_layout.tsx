// First: `crypto.getRandomValues` for the password generator.
import '@/lib/polyfills';

import { useOrganizationList } from '@weldsuite/mobile-platform/auth';
import { DefaultTheme, ThemeProvider as NavigationThemeProvider } from 'expo-router/react-navigation';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import * as SplashScreen from 'expo-splash-screen';
import 'react-native-reanimated';
import { QueryClientProvider } from '@tanstack/react-query';

import { AppLockProvider } from '@weldsuite/mobile-ui/contexts/AppLockContext';
import { AuthSessionProvider, useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';
import { ErrorBoundary } from '@weldsuite/mobile-ui/components/ErrorBoundary';
import { ServerAuthRoot } from '@weldsuite/mobile-ui/components/ServerRuntimeGate';
import { ThemeProvider, useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { ToastProvider } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { WorkspaceProvider } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';

import { BRAND } from '@/lib/brand';
import { I18nProvider, useI18n, usePersistedLanguage } from '@/lib/i18n';
import { useAppSwitcherCover } from '@/lib/privacy';
import { queryClient, trackAppFocus } from '@/lib/query-client';
import { APP, BUILD } from '@/lib/server';
import { appApi, setAppApiTokenGetter } from '@/services/app-api';
import { hideAppSplash } from '@/utils/splash';

SplashScreen.preventAutoHideAsync().catch(() => {});

/** How long one Face ID covers the next reveal or copy: a reveal and the copy right after it. */
const CONFIRM_WINDOW_MS = 10_000;

function AuthGuard({ children }: Readonly<{ children: ReactNode }>) {
  const { user, isLoading, getCredentials, organizationId } = useAuthSession();
  const router = useRouter();
  const segments = useSegments();
  const { setActive, userMemberships, isLoaded: isOrgListLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  // One workspace, or none chosen yet: take the first.
  useEffect(() => {
    if (user && !organizationId && isOrgListLoaded && setActive && userMemberships?.data?.length) {
      void setActive({ organization: userMemberships.data[0].organization.id });
    }
  }, [user, organizationId, isOrgListLoaded, setActive, userMemberships?.data]);

  // Wired during render, before child screens fire their first request
  // (effects run children-first).
  if (user) {
    setAppApiTokenGetter(async () => (await getCredentials())?.accessToken ?? null);
  } else {
    setAppApiTokenGetter(null);
  }

  // Signed out: nothing of the vaults stays in memory.
  useEffect(() => {
    if (!user) queryClient.clear();
  }, [user]);

  useEffect(() => {
    if (isLoading) return;
    if (user && !isOrgListLoaded) return;

    const inAuthGroup = segments[0] === 'authorisation' || segments[0] === 'sso-callback';
    const inNoWorkspace = segments[0] === 'no-workspace';

    if (!user) {
      if (!inAuthGroup) router.replace('/authorisation');
      return;
    }

    const hasWorkspace = (userMemberships?.data?.length ?? 0) > 0;
    if (!hasWorkspace && !inNoWorkspace) {
      router.replace('/no-workspace');
    } else if (hasWorkspace && (inAuthGroup || inNoWorkspace)) {
      router.replace('/(tabs)');
    }
  }, [user, isLoading, isOrgListLoaded, userMemberships?.data, segments, router]);

  if (isLoading || (user && !isOrgListLoaded)) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={BRAND} />
      </View>
    );
  }

  return <>{children}</>;
}

/**
 * Always on while signed in (the offline copy depends on it, PASS-010): on
 * launch, after a minute in the background, and before a reveal or a copy.
 */
function PassLock({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  const { user } = useAuthSession();
  return (
    <AppLockProvider
      mode="required"
      copy={{ ...t.lock, cancel: t.common.cancel }}
      accentColor={BRAND}
      confirmWindowMs={CONFIRM_WINDOW_MS}
      disabled={!user}
    >
      {children}
    </AppLockProvider>
  );
}

const workspaceApi = {
  // No single "current workspace" endpoint; a failure lets WorkspaceProvider
  // fall back to the session's active workspace.
  getCurrentWorkspace: () => Promise.resolve({ success: false as const }),
  getUserWorkspaces: async () => {
    try {
      const { data: workspaces } = await appApi.workspaces.list();
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

  useEffect(() => trackAppFocus(), []);

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WorkspaceProvider api={workspaceApi}>
          <NavigationThemeProvider value={navigationTheme}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <AuthGuard>
              <PassLock>
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="authorisation" />
                  <Stack.Screen name="sso-callback" />
                  <Stack.Screen name="no-workspace" options={{ animation: 'fade', gestureEnabled: false }} />
                  <Stack.Screen name="(tabs)" options={{ animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="vault/[vaultId]" />
                  <Stack.Screen name="item/[vaultId]/[itemId]/index" />
                  <Stack.Screen name="item/[vaultId]/[itemId]/edit" options={{ presentation: 'modal' }} />
                  <Stack.Screen name="item/new" options={{ presentation: 'modal' }} />
                  <Stack.Screen name="health" />
                </Stack>
              </PassLock>
            </AuthGuard>
          </NavigationThemeProvider>
        </WorkspaceProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

function AuthenticatedApp() {
  return (
    <AuthSessionProvider>
      <ThemeProvider>
        <AppStack />
      </ThemeProvider>
    </AuthSessionProvider>
  );
}

export default function RootLayout() {
  const persisted = usePersistedLanguage();
  useAppSwitcherCover();

  useEffect(() => {
    const safety = setTimeout(() => hideAppSplash(), 5000);
    return () => clearTimeout(safety);
  }, []);

  if (!persisted.ready) return null;

  return (
    <I18nProvider initialLanguage={persisted.language}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardProvider>
          <ErrorBoundary>
            {/* WeldSuite EU or a self-hosted server, signed in through its OIDC provider (WeldID). */}
            <ServerAuthRoot app={APP} build={BUILD} language={persisted.language} accentColor={BRAND} onFailed={hideAppSplash}>
              <AuthenticatedApp />
            </ServerAuthRoot>
          </ErrorBoundary>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </I18nProvider>
  );
}
