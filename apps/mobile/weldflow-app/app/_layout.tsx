import { ClerkProvider, ClerkLoaded, useOrganizationList } from '@clerk/expo';
import { DefaultTheme, ThemeProvider as NavigationThemeProvider } from 'expo-router/react-navigation';
import { Observe, ObserveRoot } from 'expo-observe';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View, ActivityIndicator, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import * as SplashScreen from 'expo-splash-screen';
import 'react-native-reanimated';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { hideAppSplash } from '@/utils/splash';

import { tokenCache } from '@clerk/expo/token-cache';
import { ClerkAuthProvider, useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { ThemeProvider, useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { ToastProvider } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { AnalyticsProvider } from '@weldsuite/mobile-ui/contexts/AnalyticsContext';
import { ErrorBoundary } from '@weldsuite/mobile-ui/components/ErrorBoundary';

import { setAppApiTokenGetter } from '@/services/app-api';
import { NotificationProvider } from '@/contexts/NotificationContext';
import { BRAND } from '@/lib/brand';
import { I18nProvider, useI18n, usePersistedLanguage } from '@/lib/i18n';

// Must run before any screen mounts — enables per-route TTR/TTI in Observe.
Observe.configure({
  integrations: { 'expo-router': true },
});

SplashScreen.preventAutoHideAsync().catch(() => {});

const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

if (!CLERK_PUBLISHABLE_KEY) {
  console.error('Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY — auth will not work');
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoading, getCredentials, organizationId } = useClerkAuth();
  const router = useRouter();
  const segments = useSegments();
  const { t } = useI18n();
  const { setActive, userMemberships, isLoaded: isOrgListLoaded } = useOrganizationList({
    userMemberships: true,
  });

  const membershipsLoading = userMemberships?.isLoading ?? true;
  const membershipCount = userMemberships?.data?.length ?? 0;

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
    if (user) {
      setAppApiTokenGetter(async () => (await getCredentials())?.accessToken ?? null);
    } else {
      setAppApiTokenGetter(null);
    }
  }, [user, getCredentials]);

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

    if (!hasOrg) {
      if (!inNoWorkspace) router.replace('/no-workspace');
      return;
    }

    if (inAuthGroup || inNoWorkspace || inSsoCallback) {
      router.replace('/(tabs)');
    }
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
                <Stack.Screen name="project/[projectId]" />
                <Stack.Screen name="task/[projectId]/[taskId]" />
                <Stack.Screen name="task/new/[projectId]" />
                <Stack.Screen name="task/edit/[projectId]/[taskId]" />
              </Stack>
            </AuthGuard>
          </NavigationThemeProvider>
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
  const updating = !ready;

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
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardProvider>
          <ErrorBoundary>
            <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY || ''} tokenCache={tokenCache}>
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
