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

import { hideAppSplash } from '@/utils/splash';

import { tokenCache } from '@clerk/expo/token-cache';
import { ClerkAuthProvider, useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { ThemeProvider, useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { ToastProvider } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { AnalyticsProvider } from '@weldsuite/mobile-ui/contexts/AnalyticsContext';
import { ErrorBoundary } from '@weldsuite/mobile-ui/components/ErrorBoundary';
import { WorkspaceProvider } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { InstalledAppsProvider } from '@weldsuite/mobile-ui/contexts/InstalledAppsContext';

import appApi, { setAppApiTokenGetter } from '@/services/app-api';
import { NotificationProvider } from '@/contexts/NotificationContext';
import { useUpdateGate } from '@/hooks/useUpdateGate';
import { I18nProvider, ProfileLanguageSync, useI18n, usePersistedLanguage } from '@/lib/i18n';
import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';
import { BRAND } from '@/lib/brand';

Observe.configure({
  integrations: { 'expo-router': true },
});

SplashScreen.preventAutoHideAsync().catch(() => {});

const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

if (!CLERK_PUBLISHABLE_KEY) {
  console.error('Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY — auth will not work');
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoading, getCredentials, organizationId } = useClerkAuth();
  const router = useRouter();
  const segments = useSegments();
  const { t } = useI18n();
  const { setActive, userMemberships, isLoaded: isOrgListLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  useEffect(() => {
    if (user && !organizationId && isOrgListLoaded && setActive && userMemberships?.data?.length) {
      setActive({ organization: userMemberships.data[0].organization.id });
    }
  }, [user, organizationId, isOrgListLoaded, setActive, userMemberships?.data]);

  if (user) {
    setAppApiTokenGetter(async () => (await getCredentials())?.accessToken ?? null);
  } else {
    setAppApiTokenGetter(null);
  }

  useEffect(() => {
    if (isLoading) return;
    if (user && !isOrgListLoaded) return;

    const inAuthGroup = segments[0] === 'authorisation';
    const inNoWorkspace = segments[0] === 'no-workspace';
    const inSsoCallback = segments[0] === 'sso-callback';

    if (!user && !inAuthGroup && !inSsoCallback) {
      router.replace('/authorisation');
      return;
    }

    if (user) {
      const hasOrg = userMemberships?.data && userMemberships.data.length > 0;

      if (!hasOrg && !inNoWorkspace) {
        router.replace('/no-workspace');
        return;
      }

      if (hasOrg && (inAuthGroup || inNoWorkspace || inSsoCallback)) {
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
  getCurrentWorkspace: async () => ({ success: false as const }),
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

const installedAppsApi = {
  getInstalledApps: async () => {
    try {
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
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="authorisation" />
                  <Stack.Screen name="sso-callback" />
                  <Stack.Screen
                    name="no-workspace"
                    options={{ animation: 'fade', animationDuration: 200, gestureEnabled: false }}
                  />
                  <Stack.Screen name="(tabs)" options={{ animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="chat/new" />
                  <Stack.Screen name="chat/[id]" />
                  <Stack.Screen name="agent/new" />
                  <Stack.Screen name="agent/[id]" />
                  <Stack.Screen name="credits/index" />
                  <Stack.Screen name="settings/index" />
                </Stack>
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
          <ProfileLanguageSync />
          <AppStack />
        </ThemeProvider>
      </AnalyticsProvider>
    </ClerkAuthProvider>
  );
}

function Splash({ label }: { label: string }) {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
      <ActivityIndicator size="large" color={BRAND} />
      <Text style={{ marginTop: 16, color: '#666' }}>{label}</Text>
    </View>
  );
}

function RootLayout() {
  const checkingUpdate = useUpdateGate();
  const persisted = usePersistedLanguage();

  useEffect(() => {
    const safety = setTimeout(() => hideAppSplash(), 5000);
    return () => clearTimeout(safety);
  }, []);

  if (checkingUpdate || !persisted.ready) {
    const catalog = persisted.language === 'nl' ? nl : en;
    return <Splash label={catalog.common.updating} />;
  }

  return (
    <I18nProvider initialLanguage={persisted.language}>
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
