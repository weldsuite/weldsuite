/**
 * The outermost piece of every app's root layout: boots the app's runtime
 * (which server, its `/config.json`, which sign-in) before anything that
 * reads it renders. While it boots it renders nothing, so the native splash
 * stays up. When the chosen server can't be used it shows why, with ways out:
 * try again, go back to WeldSuite cloud, or pick another server.
 *
 * ```tsx
 * <ServerRuntimeGate app={APP} build={BUILD} language={language} onFailed={hideAppSplash}>
 *   <AuthProvider>…</AuthProvider>
 * </ServerRuntimeGate>
 * ```
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  bootMobileRuntime,
  euOriginOf,
  isServerPickerEnabled,
  offersServer,
  switchServer,
  type BootResult,
  type MobileAppIdentity,
  type MobileBuildEnv,
  type ServerChoice,
} from '@weldsuite/mobile-platform/runtime';
import { AuthLoaded, AuthLoading, AuthProvider, type ClerkProviderOptions } from '@weldsuite/mobile-platform/auth';
import { Button } from './Button';
import { ServerPicker, serverCopy, serverDisplayName, serverProblemMessage } from './ServerPicker';
import { useTheme } from '../contexts/ThemeContext';
import { Spacing } from '../constants/theme';
import { fillCopy, type ServerCopy, type ServerLanguage } from '../constants/server-copy';

export interface ServerRuntimeGateProps {
  app: MobileAppIdentity;
  build: MobileBuildEnv;
  children: ReactNode;
  language?: ServerLanguage;
  copy?: Partial<ServerCopy>;
  accentColor?: string;
  /** Called when the error screen shows (hide the splash). */
  onFailed?: () => void;
}

type GateState = { status: 'booting' } | { status: 'error'; error: unknown } | BootResult;

export function ServerRuntimeGate({
  app,
  build,
  children,
  language = 'en',
  copy,
  accentColor = '#3B82F6',
  onFailed,
}: Readonly<ServerRuntimeGateProps>) {
  const [state, setState] = useState<GateState>({ status: 'booting' });

  const boot = useCallback(() => {
    setState({ status: 'booting' });
    // A rejection is a build that leaves the app no server (`NoServerError`).
    void bootMobileRuntime(app, build).then(setState, (error: unknown) => setState({ status: 'error', error }));
    // `app` and `build` are module constants in every app, so this runs once.
  }, [app, build]);

  useEffect(boot, [boot]);

  useEffect(() => {
    if (state.status === 'failed' || state.status === 'error') onFailed?.();
  }, [state.status, onFailed]);

  if (state.status === 'booting') return null;
  if (state.status === 'ready') return <>{children}</>;
  // A broken build, not a server problem: the app's error boundary shows it.
  if (state.status === 'error') throw state.error;
  return (
    <BootFailed
      result={state}
      onRetry={boot}
      language={language}
      copy={copy}
      accentColor={accentColor}
    />
  );
}

export interface ServerAuthRootProps extends Omit<ServerRuntimeGateProps, 'children'> {
  /** The app, rendered once the server is known and sign-in has loaded. */
  children: ReactNode;
  /** Shown while the identity provider loads (Clerk's `ClerkLoading`). */
  loading?: ReactNode;
  /** Clerk options, such as `@clerk/expo/passkeys` for apps with passkey sign-in. */
  clerk?: ClerkProviderOptions;
}

/**
 * The root every app's layout renders: the server (`ServerRuntimeGate`), its
 * sign-in (`AuthProvider`: Clerk on WeldSuite cloud, OIDC elsewhere), then the
 * app once that has loaded.
 *
 * ```tsx
 * <ServerAuthRoot app={APP} build={BUILD} language={language} accentColor={BRAND} onFailed={hideAppSplash}>
 *   <AuthenticatedApp />
 * </ServerAuthRoot>
 * ```
 */
export function ServerAuthRoot({ children, loading = null, clerk, ...gate }: Readonly<ServerAuthRootProps>) {
  return (
    <ServerRuntimeGate {...gate}>
      <AuthProvider clerk={clerk}>
        <AuthLoading>{loading}</AuthLoading>
        <AuthLoaded>{children}</AuthLoaded>
      </AuthProvider>
    </ServerRuntimeGate>
  );
}

/**
 * The server the error screen offers to go back to: WeldSuite cloud while the
 * app offers it, else WeldSuite EU (unless EU is the one that failed).
 */
function fallbackServer(result: Extract<BootResult, { status: 'failed' }>): ServerChoice | null {
  if (offersServer(result.app, 'global')) return { kind: 'global' };
  const euOrigin = euOriginOf(result.build);
  if (!euOrigin || !offersServer(result.app, 'eu') || result.choice.kind === 'eu') return null;
  return { kind: 'eu', origin: euOrigin };
}

function BootFailed({
  result,
  onRetry,
  language,
  copy,
  accentColor,
}: Readonly<{
  result: Extract<BootResult, { status: 'failed' }>;
  onRetry: () => void;
  language: ServerLanguage;
  copy?: Partial<ServerCopy>;
  accentColor: string;
}>) {
  const { colors } = useTheme();
  const [picking, setPicking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const labels = serverCopy(language, copy);
  const server = serverDisplayName(result.choice, labels);
  const fallback = fallbackServer(result);

  return (
    <View testID="server-boot-failed" style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.text }]}>{fillCopy(labels.bootFailedTitle, { server })}</Text>
        <Text style={[styles.body, { color: colors.mutedForeground }]}>
          {serverProblemMessage(result.problem, labels, result.app.name)}
        </Text>
        <View style={styles.actions}>
          {/* Also the only way out when there's no other server to go to (the server may change). */}
          {result.problem === 'unreachable' || (!fallback && !isServerPickerEnabled(result.build)) ? (
            <Button title={labels.tryAgain} onPress={onRetry} fullWidth style={{ backgroundColor: accentColor }} />
          ) : null}
          {fallback ? (
            <Button
              title={fallback.kind === 'global' ? labels.useCloud : labels.useEu}
              variant="secondary"
              loading={leaving}
              onPress={() => {
                setLeaving(true);
                void switchServer(fallback).finally(() => setLeaving(false));
              }}
              fullWidth
            />
          ) : null}
          {/* Without the picker the build always starts on its own server: nothing to change to. */}
          {isServerPickerEnabled(result.build) ? (
            <Button title={labels.changeServer} variant="ghost" onPress={() => setPicking(true)} fullWidth />
          ) : null}
        </View>
      </View>
      <ServerPicker
        visible={picking}
        onClose={() => setPicking(false)}
        app={result.app}
        current={result.choice}
        euOrigin={euOriginOf(result.build)}
        language={language}
        copy={copy}
        accentColor={accentColor}
        confirm={false}
        allowInsecure={__DEV__}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
  },
  content: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    lineHeight: 28,
    marginBottom: Spacing.sm,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
  },
  actions: {
    marginTop: Spacing.xl,
    gap: Spacing.sm,
  },
});
