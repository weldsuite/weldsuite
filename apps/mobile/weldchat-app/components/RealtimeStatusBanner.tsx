/**
 * Slim connection-status bar shown when the realtime socket is not connected.
 *
 * Reads the shared WorkspaceClient state via useRealtimeConnection(). Renders
 * nothing while connected. Debounced so a quick reconnect doesn't flash a
 * banner. Sits just below the status bar (safe-area top inset).
 */

import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRealtimeConnection } from '@weldsuite/realtime/react';
import { useTheme } from '@/contexts/ThemeContext';

/** Only surface a banner after the socket has been down this long (anti-flicker). */
const SHOW_AFTER_MS = 1500;

export function RealtimeStatusBanner() {
  const { state } = useRealtimeConnection();
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

  if (!visible || state === 'connected') return null;

  const label = state === 'disconnected' ? 'Waiting for network…' : 'Reconnecting…';

  return (
    <View
      style={[
        styles.bar,
        { paddingTop: insets.top + 6, backgroundColor: colors.bgTertiary, borderBottomColor: colors.border },
      ]}
      pointerEvents="none"
    >
      <ActivityIndicator size="small" color={colors.textMuted} />
      <Text style={[styles.text, { color: colors.textSecondary }]}>{label}</Text>
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
