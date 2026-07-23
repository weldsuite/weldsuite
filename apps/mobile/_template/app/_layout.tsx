import { ClerkProvider, ClerkLoaded, useOrganizationList } from '@clerk/expo';
import { DefaultTheme, ThemeProvider as NavigationThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
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

import appApi, { setAppApiTokenGetter } from '@/services/app-api';
import { NotificationProvider } from '@/contexts/NotificationContext';
import { RealtimeProvider } from '@/providers/realtime-provider';
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

  // Auto-select first org if user has memberships but none active
  useEffect(() => {
    if (user && !organizationId && isOrgListLoaded && setActive && userMemberships?.data?.length) {
      setActive({ organization: userMemberships.data[0].organization.id });
    }
  }, [user, organizationId, isOrgListLoaded, setActive, userMemberships?.data]);

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
        <ActivityIndicator size="large" color="{{PRIMARY_COLOR}}" />
        <Text style={{ marginTop: 16, color: '#666' }}>Loading...</Text>
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
                    <Stack.Screen name="no-workspace" options={{ animation: 'fade', animationDuration: 200, gestureEnabled: false }} />
                    <Stack.Screen name="(tabs)" options={{ animation: 'fade', animationDuration: 150 }} />
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
        <ActivityIndicator size="large" color="{{PRIMARY_COLOR}}" />
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
