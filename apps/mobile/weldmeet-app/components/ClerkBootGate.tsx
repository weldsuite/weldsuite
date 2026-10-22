import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { useAuth } from '@clerk/expo';

import { t } from '@/lib/i18n';
import { probeClerkFrontendApi } from '@/utils/clerk-diagnostics';
import { hideAppSplash } from '@/utils/splash';

/** How long Clerk may take to load before the boot screen offers a retry. */
export const CLERK_LOAD_TIMEOUT_MS = 12_000;

const ACCENT = '#7C3AED';

function useBootColors() {
  const dark = useColorScheme() === 'dark';
  return {
    background: dark ? '#000000' : '#FFFFFF',
    text: dark ? '#FFFFFF' : '#111827',
    muted: dark ? '#9CA3AF' : '#6B7280',
  };
}

function BootLoading() {
  const colors = useBootColors();
  return (
    <View style={[styles.fill, { backgroundColor: colors.background }]} testID="boot-loading">
      <ActivityIndicator size="large" color={ACCENT} />
      <Text style={[styles.message, { color: colors.muted }]}>{t.boot.loading}</Text>
    </View>
  );
}

function BootFailed({ publishableKey, onRetry }: Readonly<{ publishableKey: string | undefined; onRetry: () => void }>) {
  const colors = useBootColors();
  const [details, setDetails] = useState<string | null>(null);

  useEffect(() => {
    // The native splash may still be up (it is released by the sign-in screen).
    hideAppSplash();
    let active = true;
    probeClerkFrontendApi(publishableKey).then((line) => {
      if (active) setDetails(line);
    });
    return () => {
      active = false;
    };
  }, [publishableKey]);

  return (
    <View style={[styles.fill, styles.overlay, { backgroundColor: colors.background }]} testID="boot-failed">
      <Text style={[styles.title, { color: colors.text }]}>{t.boot.failedTitle}</Text>
      <Text style={[styles.message, { color: colors.muted }]}>{t.boot.failedMessage}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        style={({ pressed }) => [styles.button, { opacity: pressed ? 0.7 : 1 }]}
      >
        <Text style={styles.buttonText}>{t.boot.retry}</Text>
      </Pressable>
      <Text style={[styles.details, { color: colors.muted }]} selectable>
        {t.boot.details}: {details ?? t.boot.checking}
      </Text>
    </View>
  );
}

/**
 * Sits next to `<ClerkLoaded>` inside `<ClerkProvider>`. Without it the app is a
 * blank screen whenever Clerk is slow or fails to load: `ClerkLoaded` renders
 * nothing until Clerk is ready, and `@clerk/react` swallows a failed headless
 * load, so there was never an error to show.
 *
 * - While Clerk loads (including after a failed load, which `ClerkLoading` would
 *   not cover): a spinner.
 * - When it has not loaded after {@link CLERK_LOAD_TIMEOUT_MS}, or loading
 *   failed: an error screen with Try again (remounts the provider through
 *   `onRetry`) and a one-line connectivity probe of the Clerk frontend API.
 */
export function ClerkBootGate({ publishableKey, onRetry }: Readonly<{ publishableKey: string | undefined; onRetry: () => void }>) {
  const { isLoaded } = useAuth();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (isLoaded) {
      setTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setTimedOut(true), CLERK_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isLoaded]);

  if (isLoaded) return null;
  if (timedOut) return <BootFailed publishableKey={publishableKey} onRetry={onRetry} />;
  return <BootLoading />;
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  message: { fontSize: 15, textAlign: 'center' },
  button: { marginTop: 8, backgroundColor: ACCENT, paddingVertical: 14, paddingHorizontal: 28, borderRadius: 12 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  details: { marginTop: 16, fontSize: 12, textAlign: 'center' },
});
