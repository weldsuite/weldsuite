/**
 * Slim status bar shown when the device has no network connection.
 *
 * Reads device connectivity from NetworkContext (NetInfo). Renders nothing
 * while online. Debounced so a momentary blip (tunnel, handoff) doesn't flash a
 * banner. Sits at the very top (safe-area inset), above the RealtimeStatusBanner
 * — which suppresses itself while offline so the two never stack (a dropped
 * socket is just a symptom of being offline; one message is enough).
 *
 * Visual language mirrors components/RealtimeStatusBanner.tsx (same theme
 * tokens) but uses an amber accent to distinguish "no internet" from the
 * neutral "reconnecting" socket state.
 */

import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WifiOff } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useNetworkStatus } from '@/contexts/NetworkContext';

/** Only surface the banner after we've been offline this long (anti-flicker). */
const SHOW_AFTER_MS = 1200;

export function OfflineBanner() {
  const { isOnline } = useNetworkStatus();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (isOnline) {
      setVisible(false);
      return;
    }
    // Delay showing so brief drops stay silent.
    timerRef.current = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isOnline]);

  if (!visible || isOnline) return null;

  return (
    <View
      style={[
        styles.bar,
        {
          paddingTop: insets.top + 6,
          backgroundColor: colors.card,
          borderBottomColor: colors.border,
        },
      ]}
      pointerEvents="none"
    >
      <WifiOff size={15} color="#D97706" />
      <Text style={[styles.text, { color: colors.muted }]}>No internet connection</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1001, // above RealtimeStatusBanner (1000)
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: {
    fontSize: 13,
    fontWeight: '500',
  },
});
