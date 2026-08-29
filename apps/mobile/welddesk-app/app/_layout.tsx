import { ClerkProvider, ClerkLoaded, useOrganizationList } from '@clerk/expo';
import { DefaultTheme, ThemeProvider as NavigationThemeProvider } from 'expo-router/react-navigation';
import { Observe, ObserveRoot } from 'expo-observe';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
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

import storage from '@weldsuite/mobile-ui/utils/storage';
import api from '@/services/api';
import { NotificationProvider } from '@/contexts/NotificationContext';
import { RealtimeProvider } from '@/providers/realtime-provider';
import { STORAGE_KEYS } from '@/types/setup';
import { useUpdateGate } from '@/hooks/useUpdateGate';
import { I18nProvider, useI18n, usePersistedLanguage } from '@/lib/i18n';
import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';
import { BRAND } from '@/lib/brand';

// Must run before any screen mounts — enables per-route TTR/TTI in Observe.
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

  const membershipsLoading = userMemberships?.isLoading ?? true;
  const membershipCount = userMemberships?.data?.length ?? 0;

  const [setupChecked, setSetupChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState<'new' | 'existing' | null>(null);

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
      api.setTokenRefreshCallback(async () => {
        const credentials = await getCredentials();
        return credentials?.accessToken || null;
      });
    } else {
      api.setTokenRefreshCallback(null);
    }
  }, [user, getCredentials]);

  useEffect(() => {
    const initializeServices = async () => {
      if (user) {
        const credentials = await getCredentials();
        if (credentials?.accessToken) {
          api.setAccessToken(credentials.accessToken);
          api.setOrganizationId(credentials.organizationId || user.organizationId || null);
        }
      } else {
        api.setAccessToken(null);
        api.setOrganizationId(null);
      }
    };
    void initializeServices();
  }, [user, getCredentials]);

  useEffect(() => {
    if (!user) {
      setSetupChecked(false);
      setNeedsSetup(null);
      storage.removeItem(STORAGE_KEYS.completed);
      storage.removeItem(STORAGE_KEYS.formData);
      storage.removeItem(STORAGE_KEYS.currentStep);
      storage.removeItem(STORAGE_KEYS.mode);
    }
  }, [user]);

  useEffect(() => {
    if (!user || !isOrgListLoaded) return;
    if (membershipsLoading) return;

    const checkSetup = async () => {
      const completed = await storage.getItem(STORAGE_KEYS.completed);
      if (completed === 'true') {
        setNeedsSetup(null);
        setSetupChecked(true);
        return;
      }

      if (membershipCount === 0) {
        setNeedsSetup('new');
        setSetupChecked(true);
        return;
      }

      await storage.setItem(STORAGE_KEYS.completed, 'true');
      setNeedsSetup(null);
      setSetupChecked(true);
    };

    void checkSetup();
  }, [user, isOrgListLoaded, membershipsLoading, membershipCount]);

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === 'authorisation';
    const inSetup = segments[0] === 'setup';

    if (!user && !inAuthGroup) {
      router.replace('/authorisation');
      return;
    }

    if (user && !setupChecked) return;

    if (user && inAuthGroup) {
      if (needsSetup) {
        router.replace({ pathname: '/setup', params: { mode: needsSetup } });
      } else {
        router.replace('/(tabs)');
      }
    } else if (user && needsSetup && !inSetup && !inAuthGroup) {
      router.replace({ pathname: '/setup', params: { mode: needsSetup } });
    } else if (user && !needsSetup && inSetup) {
      router.replace('/(tabs)');
    }
  }, [user, isLoading, setupChecked, needsSetup, segments, router]);

  if (
    isLoading ||
    (user && !isOrgListLoaded) ||
    (user && membershipsLoading) ||
    (user && !setupChecked)
  ) {
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
  getCurrentWorkspace: () => api.getCurrentWorkspace(),
  getUserWorkspaces: () => api.getUserWorkspaces(),
};

const installedAppsApi = {
  getInstalledApps: () => api.getInstalledApps(),
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
                  <Stack screenOptions={{ headerShown: false }}>
                    <Stack.Screen name="authorisation" />
                    <Stack.Screen name="sso-callback" />
                    <Stack.Screen
                      name="setup"
                      options={{ animation: 'fade', animationDuration: 200, gestureEnabled: false }}
                    />
                    <Stack.Screen name="(tabs)" options={{ animation: 'fade', animationDuration: 150 }} />
                    <Stack.Screen name="conversation/[id]" />
                  </Stack>
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
