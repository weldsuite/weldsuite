import { ClerkProvider, ClerkLoaded, ClerkLoading, useOrganizationList } from '@clerk/expo';
import { DefaultTheme, ThemeProvider as NavigationThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  useFonts,
  Inter_100Thin,
  Inter_200ExtraLight,
  Inter_300Light,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
  Inter_900Black,
} from '@expo-google-fonts/inter';
import { useEffect } from 'react';
import { View, Text } from 'react-native';
import MaterialSpinner from '@/components/MaterialSpinner';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import 'react-native-reanimated';

import { applyInterAsDefaultFont } from '@/utils/inter-font';

applyInterAsDefaultFont();

import { tokenCache } from '@clerk/expo/token-cache';
import { ClerkAuthProvider, useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { ThemeProvider, useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { ToastProvider } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { AnalyticsProvider } from '@weldsuite/mobile-ui/contexts/AnalyticsContext';
import { ErrorBoundary } from '@weldsuite/mobile-ui/components/ErrorBoundary';
import { WorkspaceProvider } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { InstalledAppsProvider } from '@weldsuite/mobile-ui/contexts/InstalledAppsContext';

import appApi, { appApiClient, setAppApiTokenGetter } from '@/services/app-api';
import { NotificationProvider } from '@/contexts/NotificationContext';
import { PermissionProvider } from '@/contexts/PermissionContext';
import { MailProvider } from '@/contexts/MailContext';
import { PinnedMessagesProvider } from '@/contexts/PinnedMessagesContext';
import { ComposeOverlayProvider } from '@/contexts/ComposeOverlayContext';
import { RealtimeProvider } from '@/providers/realtime-provider';
import { NetworkProvider } from '@/contexts/NetworkContext';
import { OfflineBanner } from '@/components/OfflineBanner';
import { OutboxFlusher } from '@/components/OutboxFlusher';
import { useMailRealtime } from '@/hooks/useMailRealtime';
import { useUpdateGate } from '@/hooks/useUpdateGate';

const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

function FullScreenLoader({ label }: { label: string }) {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <MaterialSpinner size={20} strokeWidth={2.6} color="#3B82F6" spinning />
        <Text style={{ color: '#666' }}>{label}</Text>
      </View>
    </View>
  );
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
    if (user) {
      setAppApiTokenGetter(async () => {
        const credentials = await getCredentials();
        return credentials?.accessToken || null;
      });
    } else {
      setAppApiTokenGetter(null);
    }
  }, [user, getCredentials]);

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === 'authorisation';
    const inNoWorkspace = segments[0] === 'no-workspace';
    const inSsoCallback = segments[0] === 'sso-callback';

    if (!user) {
      if (!inAuthGroup && !inSsoCallback) router.replace('/authorisation');
      return;
    }

    if (user && !isOrgListLoaded) return;
    // Wait for Clerk to finish fetching memberships before making routing decisions.
    // Otherwise we briefly see data.length === 0 and wrongly redirect to no-workspace.
    if (user && membershipsLoading) return;

    const hasOrg = membershipCount > 0 || !!organizationId;

    if (!hasOrg && !inNoWorkspace) {
      router.replace('/no-workspace');
    } else if (hasOrg && (inAuthGroup || inNoWorkspace || inSsoCallback)) {
      router.replace('/');
    }
  }, [user, isLoading, isOrgListLoaded, membershipsLoading, membershipCount, organizationId, segments, router]);

  if (isLoading || (user && !isOrgListLoaded) || (user && membershipsLoading)) {
    return <FullScreenLoader label="Loading..." />;
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
 * Mounts the useMailRealtime hook. Must live inside both RealtimeProvider
 * (for the WorkspaceClient context) and MailProvider (for refreshMail).
 * Returns null — purely a side-effect component.
 */
function MailRealtimeWatcher() {
  useMailRealtime();
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
      <NotificationProvider>
        <InstalledAppsProvider api={installedAppsApi}>
          <WorkspaceProvider api={workspaceApi}>
            <PermissionProvider>
            <MailProvider>
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
                    <Stack.Screen name="index" options={{ headerShown: false }} />
                    <Stack.Screen
                      name="[id]"
                      options={{
                        headerShown: false,
                        presentation: 'card',
                        gestureEnabled: true,
                        gestureDirection: 'horizontal',
                        fullScreenGestureEnabled: true, // Gmail-style: swipe from anywhere on the page
                        animation: 'slide_from_right',
                      }}
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
            </MailProvider>
            </PermissionProvider>
          </WorkspaceProvider>
        </InstalledAppsProvider>
      </NotificationProvider>
    </ToastProvider>
    </RealtimeProvider>
    </NetworkProvider>
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

  const [fontsLoaded, fontError] = useFonts({
    Inter_100Thin,
    Inter_200ExtraLight,
    Inter_300Light,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
    Inter_900Black,
  });

  if (checkingUpdate) {
    return <FullScreenLoader label="Updating…" />;
  }

  // Hold render until fonts are ready. The native splash will auto-hide
  // when this component returns its real tree (no manual SplashScreen.* calls
  // needed — those conflict with sheet/modal view controllers).
  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ErrorBoundary>
          <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY || ''} tokenCache={tokenCache}>
            <ClerkLoading>
              <FullScreenLoader label="Initializing..." />
            </ClerkLoading>
            <ClerkLoaded>
              <AuthenticatedApp />
            </ClerkLoaded>
          </ClerkProvider>
        </ErrorBoundary>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
