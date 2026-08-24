import { ClerkProvider, ClerkLoaded, useOrganizationList } from '@clerk/expo';
import { DefaultTheme, ThemeProvider as NavigationThemeProvider } from 'expo-router/react-navigation';
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

import api from '@/services/api';
import { NotificationProvider } from '@/contexts/NotificationContext';
import { OfflineQueueProvider } from '@/contexts/OfflineQueueContext';
import {
  AccountingEntityProvider,
  useAccountingEntity,
} from '@/contexts/AccountingEntityContext';
import { EntityEmptyState } from '@/components/entity-setup';
import { ErrorState } from '@/components/data-states';
import { Screen } from '@/components/screen';
import { useUpdateGate } from '@/hooks/useUpdateGate';

const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoading, getCredentials, organizationId } = useClerkAuth();
  const router = useRouter();
  const segments = useSegments();
  const { setActive, userMemberships, isLoaded: isOrgListLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  useEffect(() => {
    if (user && !organizationId && isOrgListLoaded && setActive && userMemberships?.data?.length) {
      setActive({ organization: userMemberships.data[0].organization.id });
    }
  }, [user, organizationId, isOrgListLoaded, setActive, userMemberships?.data]);

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
    initializeServices();
  }, [user, getCredentials]);

  useEffect(() => {
    if (isLoading) return;
    const inAuthGroup = segments[0] === 'authorisation';
    const inSsoCallback = segments[0] === 'sso-callback';
    if (!user && !inAuthGroup && !inSsoCallback) {
      router.replace('/authorisation');
    } else if (user && (inAuthGroup || inSsoCallback)) {
      router.replace('/(tabs)');
    }
  }, [user, isLoading, segments, router]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <ActivityIndicator size="large" color="#10B981" />
        <Text style={{ marginTop: 16, color: '#666' }}>Loading...</Text>
      </View>
    );
  }

  return <>{children}</>;
}

/**
 * Gates the app on the workspace having an accounting entity — the mobile twin
 * of the platform's AccountingLayoutClient. Without one every accounting
 * endpoint returns `400 No accounting entity resolved`, so we show the setup
 * door rather than a stack of broken screens.
 *
 * Signed-out users pass straight through; AuthGuard is redirecting them.
 */
function EntityGate({ children }: { children: React.ReactNode }) {
  const { user } = useClerkAuth();
  const { hasEntity, isLoading, loadError, isRefreshing, refresh } = useAccountingEntity();
  const { colors } = useTheme();

  if (!user) return <>{children}</>;

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator size="large" color="#10B981" />
      </View>
    );
  }

  if (loadError) {
    return (
      <Screen>
        <ErrorState
          message="Couldn't load your company details. Check your connection and try again."
          onRetry={refresh}
          retrying={isRefreshing}
        />
      </Screen>
    );
  }

  if (!hasEntity) return <EntityEmptyState onCreated={refresh} />;

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
        <OfflineQueueProvider>
          <InstalledAppsProvider api={installedAppsApi}>
            <WorkspaceProvider api={workspaceApi}>
              <AccountingEntityProvider>
                <NavigationThemeProvider value={navigationTheme}>
                  <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
                  <AuthGuard>
                    <EntityGate>
                      <Stack screenOptions={{ headerShown: false }}>
                        <Stack.Screen name="authorisation" />
                        <Stack.Screen name="sso-callback" />
                        <Stack.Screen name="(tabs)" options={{ animation: 'fade', animationDuration: 150 }} />
                        <Stack.Screen name="invoice/[id]" />
                        <Stack.Screen name="invoice/new" />
                        <Stack.Screen name="invoice/document" options={{ presentation: 'modal' }} />
                        <Stack.Screen name="bill/[id]" />
                        <Stack.Screen name="bill/new" />
                        <Stack.Screen name="expense/quick" />
                        <Stack.Screen name="scan/index" options={{ presentation: 'fullScreenModal' }} />
                        <Stack.Screen name="bank/index" />
                        <Stack.Screen name="bank/[id]" />
                        <Stack.Screen name="reconciliation/index" />
                        <Stack.Screen name="vat/index" />
                        <Stack.Screen name="vat/[id]" />
                        <Stack.Screen name="reports/index" />
                        <Stack.Screen name="reports/profit-loss" />
                        <Stack.Screen name="reports/balance-sheet" />
                        <Stack.Screen name="contacts/index" />
                        <Stack.Screen name="contacts/new" />
                        <Stack.Screen name="contacts/[id]" />
                        <Stack.Screen name="settings/index" />
                      </Stack>
                    </EntityGate>
                  </AuthGuard>
                </NavigationThemeProvider>
              </AccountingEntityProvider>
            </WorkspaceProvider>
          </InstalledAppsProvider>
        </OfflineQueueProvider>
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
        <ActivityIndicator size="large" color="#10B981" />
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
