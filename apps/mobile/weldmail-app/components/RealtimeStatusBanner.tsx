/**
 * Slim connection-status bar shown when the realtime socket is not connected.
 *
 * Reads the shared WorkspaceClient state via useRealtimeConnection(). Renders
 * nothing while connected. Debounced so a quick reconnect doesn't flash a
 * banner. Sits just below the status bar (safe-area top inset).
 *
 * Adapted from apps/mobile/weldchat-app/components/RealtimeStatusBanner.tsx
 * with weldmail color tokens (uses @weldsuite/mobile-ui ThemeContext).
 */

import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRealtimeConnection } from '@weldsuite/realtime/react';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useNetworkStatus } from '@/contexts/NetworkContext';

/**
 * Only surface a banner after the socket has been down this long (anti-flicker).
 * Kept generous so the routine drops — app backgrounding, token refresh, brief
 * network blips, and the foreground reconnect on resume — all resolve silently.
 * Only a genuinely sustained outage crosses this threshold.
 */
const SHOW_AFTER_MS = 5000;

export function RealtimeStatusBanner() {
  const { state } = useRealtimeConnection();
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
    if (state === 'connected') {
      setVisible(false);
      return;
    }
    // Delay showing so brief blips (token refresh, fast reconnect) stay silent.
    timerRef.current = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [state]);

  // While the device is offline the OfflineBanner owns the top bar — a dropped
  // socket is just a downstream symptom, so suppress this one to avoid stacking.
  if (!visible || state === 'connected' || !isOnline) return null;

  const label = state === 'disconnected' ? 'Waiting for network…' : 'Reconnecting…';

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
      <ActivityIndicator size="small" color={colors.muted} />
      <Text style={[styles.text, { color: colors.muted }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
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
