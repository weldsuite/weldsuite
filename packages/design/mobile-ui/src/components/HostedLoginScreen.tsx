/**
 * Sign-in on the server's own page (OIDC: WeldID on WeldSuite EU, any
 * provider on a self-hosted server): one button to sign in, one to create an
 * account, both opening the provider in the system browser sheet. The
 * provider's page is asked for the app's language.
 *
 * `LoginScreen` renders this on OIDC servers. An app that runs on OIDC
 * servers only (no WeldSuite cloud, `MobileAppIdentity.servers`) imports it
 * directly: unlike `LoginScreen` it loads nothing of Clerk.
 */

import { useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View, type ImageSourcePropType } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { OidcSignInError, useHostedSignIn } from '@weldsuite/mobile-platform/auth';
import { hostOf, peekMobileRuntime } from '@weldsuite/mobile-platform/runtime';
import { LOGIN_COPY, type LoginLanguage, type LoginScreenCopy } from '../constants/login-copy';
import { fillCopy, SERVER_COPY, type ServerCopy } from '../constants/server-copy';
import { Spacing } from '../constants/theme';
import { useTheme } from '../contexts/ThemeContext';
import { FormErrorBox, LoginLogo, loginStyles, SubmitButton, useWarmUpBrowser } from './LoginParts';
import { ServerRow } from './ServerRow';

export interface HostedLoginScreenProps {
  /** Custom logo element (e.g. an SVG wordmark). Takes precedence over `logo`. */
  logoElement?: ReactNode;
  /** Image source for the logo (e.g. require('./logo.png')) */
  logo?: ImageSourcePropType;
  /** Logo dimensions override (default: { width: 40, height: 40 } inside the brand tile) */
  logoSize?: { width: number; height: number };
  /** App name displayed as text when no logo is provided */
  appName: string;
  /** Subtitle text below the title */
  subtitle?: string;
  /** Built-in copy to start from, and the language asked of the provider's page (default: 'en'). */
  language?: LoginLanguage;
  /** Overrides for the title and subtitle. */
  copy?: Partial<Pick<LoginScreenCopy, 'signInTitle' | 'subtitle'>>;
  /** Brand accent for the sign-in button (default: '#3B82F6') */
  accentColor?: string;
  /** Overrides for the server row, picker and hosted sign-in copy (`server-copy.ts`). */
  serverCopy?: Partial<ServerCopy>;
}

export function HostedLoginScreen({
  logoElement,
  logo,
  logoSize,
  appName,
  subtitle,
  language = 'en',
  copy,
  accentColor = '#3B82F6',
  serverCopy,
}: Readonly<HostedLoginScreenProps>) {
  useWarmUpBrowser();
  const { colors } = useTheme();
  const hosted = useHostedSignIn();
  const [busy, setBusy] = useState<'sign-in' | 'sign-up' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = LOGIN_COPY[language];
  const labels: ServerCopy = { ...SERVER_COPY[language], ...serverCopy };
  const origin = peekMobileRuntime()?.server.origin;
  const server = origin ? hostOf(origin) : appName;

  const start = async (intent: 'sign-in' | 'sign-up') => {
    if (!hosted || busy) return;
    setBusy(intent);
    setError(null);
    try {
      // 'cancelled' (the person closed the sheet) needs no message.
      await hosted.signIn({ intent, locale: language });
    } catch (e) {
      setError(e instanceof OidcSignInError && e.code === 'unreachable' ? labels.unreachable : labels.hostedFailed);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SafeAreaView edges={['top', 'bottom']} style={[loginStyles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={loginStyles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={loginStyles.content}>
          <LoginLogo
            logoElement={logoElement}
            logo={logo}
            appName={appName}
            iconW={logoSize?.width ?? 40}
            iconH={logoSize?.height ?? 40}
            accentColor={accentColor}
            colors={colors}
          />
          <View style={loginStyles.welcomeSection}>
            <Text style={[loginStyles.pageTitle, { color: colors.text }]}>{copy?.signInTitle ?? base.signInTitle}</Text>
            <Text style={[loginStyles.subtitle, { color: colors.mutedForeground }]}>
              {copy?.subtitle ?? subtitle ?? base.subtitle}
            </Text>
          </View>
          <View style={loginStyles.formContainer}>
            <FormErrorBox message={error} colors={colors} />
            <SubmitButton
              testID="hosted-sign-in"
              accentColor={accentColor}
              loading={busy === 'sign-in'}
              onPress={() => void start('sign-in')}
              label={labels.hostedSignIn}
            />
            <TouchableOpacity
              testID="hosted-sign-up"
              style={[
                loginStyles.secondaryButton,
                styles.signUp,
                { backgroundColor: colors.secondary },
                busy !== null && loginStyles.buttonDisabled,
              ]}
              onPress={() => void start('sign-up')}
              activeOpacity={0.8}
              disabled={busy !== null}
              accessibilityRole="button"
            >
              {busy === 'sign-up' ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Text style={[loginStyles.secondaryButtonText, { color: colors.text }]}>{labels.hostedSignUp}</Text>
              )}
            </TouchableOpacity>
            <Text style={[styles.hostedHint, { color: colors.mutedForeground }]}>
              {fillCopy(labels.hostedHint, { server })}
            </Text>
          </View>
          <ServerRow variant="login" language={language} copy={serverCopy} accentColor={accentColor} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  signUp: {
    marginTop: Spacing.sm,
  },
  hostedHint: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: Spacing.md,
    textAlign: 'center',
  },
});
