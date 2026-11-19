/**
 * Pieces shared by the sign-in screens: `LoginScreen` (Clerk's own forms on
 * WeldSuite cloud) and `HostedLoginScreen` (the provider's page: WeldID on
 * EU, any OIDC provider self-hosted). Nothing here touches Clerk, so an app
 * that signs in through WeldID only never loads it.
 */

import { useEffect, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ImageSourcePropType,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Colors, Radii, Spacing } from '../constants/theme';

export type ThemeColors = typeof Colors.light;

/** White label on brand-colored CTAs — independent of light/dark primaryForeground. */
export const ACCENT_FOREGROUND = '#FFFFFF';

/** ~12% tint of an accent, matching WeldBooks icon tiles. */
export function tint(hex: string, fallback: string): string {
  const value = hex.replace('#', '');
  if (value.length !== 6) return fallback;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.12)`;
}

/** Android Custom Tabs drop the OAuth return if the browser isn't warmed up. */
export function useWarmUpBrowser() {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);
}

export interface LoginLogoProps {
  logoElement?: ReactNode;
  logo?: ImageSourcePropType;
  appName: string;
  iconW: number;
  iconH: number;
  accentColor: string;
  colors: ThemeColors;
}

export function LoginLogo({ logoElement, logo, appName, iconW, iconH, accentColor, colors }: Readonly<LoginLogoProps>) {
  if (logoElement) return <View style={loginStyles.logoElement}>{logoElement}</View>;
  if (logo) {
    return (
      <View style={[loginStyles.brandTile, { backgroundColor: tint(accentColor, colors.secondary) }]}>
        <Image source={logo} style={{ width: iconW, height: iconH }} resizeMode="contain" />
      </View>
    );
  }
  return <Text style={[loginStyles.appNameTitle, { color: colors.text }]}>{appName}</Text>;
}

export function FormErrorBox({ message, colors }: Readonly<{ message: string | null; colors: ThemeColors }>) {
  if (!message) return null;
  return (
    <View testID="login-error" style={[loginStyles.formErrorContainer, { backgroundColor: `${colors.destructive}1A` }]}>
      <Text style={[loginStyles.formErrorText, { color: colors.destructive }]}>{message}</Text>
    </View>
  );
}

export interface SubmitButtonProps {
  accentColor: string;
  loading: boolean;
  onPress: () => void;
  label: string;
  testID?: string;
}

export function SubmitButton({ accentColor, loading, onPress, label, testID }: Readonly<SubmitButtonProps>) {
  return (
    <TouchableOpacity
      testID={testID}
      style={[loginStyles.signInButton, { backgroundColor: accentColor }, loading && loginStyles.buttonDisabled]}
      onPress={onPress}
      activeOpacity={0.8}
      disabled={loading}
    >
      {loading ? (
        <ActivityIndicator color={ACCENT_FOREGROUND} />
      ) : (
        <Text style={[loginStyles.signInButtonText, { color: ACCENT_FOREGROUND }]}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

/** The layout both screens share. */
export const loginStyles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.xl,
  },
  content: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
  },
  brandTile: {
    width: 72,
    height: 72,
    borderRadius: Radii.xl,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xl,
  },
  logoElement: {
    marginBottom: Spacing.xl,
    alignSelf: 'flex-start',
  },
  appNameTitle: {
    fontSize: 26,
    fontWeight: '600',
    letterSpacing: -0.4,
    lineHeight: 32,
    marginBottom: Spacing.xl,
  },
  welcomeSection: {
    marginBottom: 28,
  },
  pageTitle: {
    fontSize: 26,
    fontWeight: '600',
    letterSpacing: -0.4,
    lineHeight: 32,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
  },
  formContainer: {
    width: '100%',
  },
  formErrorContainer: {
    width: '100%',
    marginBottom: Spacing.lg,
    padding: Spacing.md,
    borderRadius: Radii.md,
  },
  formErrorText: {
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
  },
  signInButton: {
    width: '100%',
    height: 52,
    borderRadius: Radii.lg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  signInButtonText: {
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  secondaryButton: {
    width: '100%',
    height: 52,
    borderRadius: Radii.lg,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
