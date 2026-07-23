import { ClerkProvider, ClerkLoaded, useOrganizationList } from '@clerk/expo';
import { DefaultTheme, ThemeProvider as NavigationThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { View, ActivityIndicator, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import 'react-native-reanimated';

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

const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

if (!CLERK_PUBLISHABLE_KEY) {
  console.error('Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY — auth will not work');
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoading, getCredentials, organizationId } = useClerkAuth();
  const router = useRouter();
  const segments = useSegments();
  const { setActive, userMemberships, isLoaded: isOrgListLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  const membershipsLoading = userMemberships?.isLoading ?? true;
  const membershipCount = userMemberships?.data?.length ?? 0;

  const [setupChecked, setSetupChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState<'new' | 'existing' | null>(null);

  // Auto-select first org if user has memberships but none active
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

  // Set up API token refresh
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

  // Initialize API services with credentials
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
    initializeServices();
  }, [user, getCredentials]);

  // Clear setup state on sign-out
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

  // Determine if user needs setup
  useEffect(() => {
    if (!user || !isOrgListLoaded) return;
    // Wait for Clerk to finish fetching memberships before deciding.
    // Otherwise we briefly see data.length === 0 and wrongly route to setup ("create workspace").
    if (membershipsLoading) return;

    const checkSetup = async () => {
      // Check local flag first (fast path)
      const completed = await storage.getItem(STORAGE_KEYS.completed);
      if (completed === 'true') {
        setNeedsSetup(null);
        setSetupChecked(true);
        return;
      }

      // No org memberships = new user who needs full setup
      if (membershipCount === 0) {
        setNeedsSetup('new');
        setSetupChecked(true);
        return;
      }

      // Has org — skip onboarding, they're already set up
      await storage.setItem(STORAGE_KEYS.completed, 'true');
      setNeedsSetup(null);
      setSetupChecked(true);
    };

    checkSetup();
  }, [user, isOrgListLoaded, membershipsLoading, membershipCount]);

  // Route guard
  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === 'authorisation';
    const inSetup = segments[0] === 'setup';

    // Unauthenticated: redirect to login (no need to wait for setupChecked)
    if (!user && !inAuthGroup) {
      router.replace('/authorisation');
      return;
    }

    // Authenticated: wait for setup check before routing decisions
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

  if (isLoading || (user && !isOrgListLoaded) || (user && membershipsLoading) || (user && !setupChecked)) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <ActivityIndicator size="large" color="#3B82F6" />
        <Text style={{ marginTop: 16, color: '#666' }}>Loading...</Text>
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
    colors: { ...DefaultTheme.colors, primary: colors.text, background: colors.background, card: colors.cardBackground, text: colors.text, border: colors.divider, notification: colors.text },
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
                  <Stack.Screen name="setup" options={{ animation: 'fade', animationDuration: 200, gestureEnabled: false }} />
                  <Stack.Screen name="(tabs)" options={{ animation: 'fade', animationDuration: 150 }} />
                  <Stack.Screen name="ticket/[id]" />
                  <Stack.Screen name="ticket/new" />
                  <Stack.Screen name="contact/[id]" />
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

export default function RootLayout() {
  // First-launch OTA gate: check for and apply the latest update before the app
  // renders, so first-time installers never see the stale embedded bundle.
  const checkingUpdate = useUpdateGate();

  if (checkingUpdate) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <ActivityIndicator size="large" color="#3B82F6" />
        <Text style={{ marginTop: 16, color: '#666' }}>Updating…</Text>
      </View>
    );
  }

  return (
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
  );
}
