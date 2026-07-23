import { ClerkProvider, ClerkLoaded, useAuth, useOrganization, useOrganizationList } from '@clerk/expo';
import { DefaultTheme, ThemeProvider as NavigationThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View, ActivityIndicator, Text, LogBox } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import 'react-native-reanimated';

// Suppress known deprecation warnings
// TODO: Migrate to Firebase modular API when React Native Firebase v22 is stable
LogBox.ignoreLogs([
  'This method is deprecated (as well as all React Native Firebase namespaced API)',
  'setLayoutAnimationEnabledExperimental',
]);
import { tokenCache } from '@clerk/expo/token-cache';
import { ClerkAuthProvider, useClerkAuth } from '@/contexts/ClerkAuthContext';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { APPS_WITH_LOGOS } from '@/components/AppIcon';
// import { CartProvider } from '@/contexts/CartContext';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';
import { NotificationProvider } from '@/contexts/NotificationContext';
// import { WmsProvider } from '@/contexts/WmsContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { InstalledAppsProvider } from '@/contexts/InstalledAppsContext';
import { WorkspaceProvider } from '@/contexts/WorkspaceContext';
// import { VoipProvider } from '@/contexts/VoipContext';
import { AnalyticsProvider } from '@/contexts/AnalyticsContext';
import { I18nBootstrap } from '@/contexts/I18nBootstrap';
import { RealtimeProvider } from '@/providers/realtime-provider';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import api from '@/services/api';
import { useUpdateGate } from '@/hooks/useUpdateGate';

// Get the publishable key from environment
const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

if (!CLERK_PUBLISHABLE_KEY) {
  console.warn('Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY environment variable');
}

export const unstable_settings = {
  anchor: '(tabs)',
};

const APP_ROUTES: Record<string, string> = {
  mail: '/mail',
  crm: '/crm',
  helpdesk: '/helpdesk',
  projects: '/projects',
  task: '/task',
  host: '/host',
  commerce: '/commerce',
  accounting: '/accounting',
  wms: '/wms',
  parcel: '/parcel',
};

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoading, getCredentials, organizationId } = useClerkAuth();
  const router = useRouter();
  const segments = useSegments();
  const { installedApps, isLoading: appsLoading } = useInstalledApps();
  const { setActive, userMemberships, isLoaded: isOrgListLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  // Auto-select first organization if user is signed in but no org is active
  useEffect(() => {
    console.log('[AuthGuard] Auto-org check — user:', !!user, '| orgId:', organizationId, '| orgListLoaded:', isOrgListLoaded, '| memberships:', userMemberships?.data?.length ?? 0);
    if (user && !organizationId && isOrgListLoaded && setActive && userMemberships?.data?.length) {
      const firstOrgId = userMemberships.data[0].organization.id;
      console.log('[AuthGuard] No active org — auto-selecting:', firstOrgId);
      setActive({ organization: firstOrgId });
    }
  }, [user, organizationId, isOrgListLoaded, setActive, userMemberships?.data]);

  // Set up token refresh callback for API service
  useEffect(() => {
    if (user) {
      // Set callback that will be called before each API request to ensure fresh token
      api.setTokenRefreshCallback(async () => {
        const credentials = await getCredentials();
        return credentials?.accessToken || null;
      });
    } else {
      api.setTokenRefreshCallback(null);
    }
  }, [user, getCredentials]);

  // Initialize API with Clerk token when user is authenticated
  useEffect(() => {
    const initializeServices = async () => {
      if (user) {
        try {
          // Get credentials which includes the access token
          const credentials = await getCredentials();
          if (credentials?.accessToken) {
            // Initialize API with current token and organization
            api.setAccessToken(credentials.accessToken);
            api.setOrganizationId(credentials.organizationId || user.organizationId || null);
          }
        } catch (error) {
          console.error('Failed to initialize services:', error);
        }
      } else {
        // Clear tokens when user logs out
        api.setAccessToken(null);
        api.setOrganizationId(null);
      }
    };

    initializeServices();
  }, [user, getCredentials]);

  useEffect(() => {
    if (isLoading || appsLoading) {
      return;
    }

    const inAuthGroup = segments[0] === 'authorisation';

    if (!user && !inAuthGroup) {
      // Redirect to login if not authenticated
      router.replace('/authorisation');
    } else if (user && inAuthGroup) {
      // Redirect to first installed app, or fallback to mail
      const firstApp = installedApps
        .filter(app => APP_ROUTES[app.appCode] && APPS_WITH_LOGOS.includes(app.appCode))
        .sort((a, b) => a.displayOrder - b.displayOrder)[0];
      const route = firstApp ? APP_ROUTES[firstApp.appCode] : '/mail';
      router.replace(route as any);
    }
  }, [user, isLoading, appsLoading, installedApps, segments, router]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={{ marginTop: 16, color: '#666' }}>Loading...</Text>
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
    <ToastProvider>
      <NotificationProvider>
        <InstalledAppsProvider>
          <WorkspaceProvider>
            <RealtimeProvider>
            {/* <WmsProvider> */}
              {/* <VoipProvider> */}
                {/* <CartProvider> */}
                <NavigationThemeProvider value={navigationTheme}>
                  <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
                  <AuthGuard>
                    <Stack
                    screenOptions={{
                      headerShown: false,
                      headerStyle: {
                        backgroundColor: colors.background,
                      },
                      headerTintColor: colors.text,
                      headerTitleStyle: {
                        fontWeight: '400',
                      },
                      headerShadowVisible: false,
                    }}
                  >
                    <Stack.Screen name="authorisation" options={{ headerShown: false }} />
                    <Stack.Screen name="(tabs)" options={{ headerShown: false, animation: 'fade', animationDuration: 150 }} />
                    <Stack.Screen name="commerce" options={{ headerShown: false, animation: 'fade', animationDuration: 150 }} />
                    <Stack.Screen name="accounting" options={{ headerShown: false, animation: 'fade', animationDuration: 150 }} />
                    <Stack.Screen name="parcel" options={{ headerShown: false, animation: 'fade', animationDuration: 150 }} />
                    <Stack.Screen name="mail" options={{ headerShown: false, animation: 'fade', animationDuration: 150 }} />
                    <Stack.Screen name="wms" options={{ headerShown: false, animation: 'fade', animationDuration: 150 }} />
                    <Stack.Screen name="helpdesk" options={{ headerShown: false, animation: 'fade', animationDuration: 150 }} />
                    <Stack.Screen name="projects" options={{ headerShown: false, animation: 'fade', animationDuration: 150 }} />
                    <Stack.Screen name="crm" options={{ headerShown: false, animation: 'fade', animationDuration: 150 }} />
                    <Stack.Screen name="task" options={{ headerShown: false, animation: 'fade', animationDuration: 150 }} />
                    <Stack.Screen name="app-store" options={{ headerShown: false, animation: 'fade', animationDuration: 150 }} />
                    <Stack.Screen name="product/new" options={{ headerShown: false }} />
                    <Stack.Screen name="product/edit/[id]" options={{ headerShown: false }} />
                    <Stack.Screen name="order/[id]" options={{ headerShown: false }} />
                    <Stack.Screen name="invoice/[id]" options={{ headerShown: false }} />
                    <Stack.Screen name="customer/[id]" options={{ headerShown: false }} />
                    <Stack.Screen name="bank/[id]" options={{ headerShown: false }} />
                    <Stack.Screen name="settings" options={{ headerShown: false }} />
                    <Stack.Screen name="+not-found" options={{ headerShown: true }} />
                  </Stack>
                  </AuthGuard>
                </NavigationThemeProvider>
                {/* </CartProvider> */}
              {/* </VoipProvider> */}
            {/* </WmsProvider> */}
          </RealtimeProvider>
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
          <I18nBootstrap>
            <AppStack />
          </I18nBootstrap>
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
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={{ marginTop: 16, color: '#666' }}>Updating…</Text>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ErrorBoundary>
          <ClerkProvider
            publishableKey={CLERK_PUBLISHABLE_KEY || ''}
            tokenCache={tokenCache}
          >
            <ClerkLoaded>
              <AuthenticatedApp />
            </ClerkLoaded>
          </ClerkProvider>
        </ErrorBoundary>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
