/**
 * Loading / error / empty list placeholders — same shapes as WeldBooks so
 * failed requests always offer a retry and loading matches row density.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { AlertCircle } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Skeleton } from '@weldsuite/mobile-ui/components/Skeleton';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';

export function LoadingState({ label }: { label?: string }) {
  return (
    <View style={styles.center}>
      <Spinner size="large" label={label} />
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
  retrying = false,
}: {
  message?: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.center}>
      <AlertCircle size={40} color={colors.destructive} />
      <Text style={[styles.errorText, { color: colors.mutedForeground }]}>
        {message ?? 'Something went wrong'}
      </Text>
      {onRetry ? (
        <Button title="Try again" variant="outline" size="sm" onPress={onRetry} loading={retrying} />
      ) : null}
    </View>
  );
}

/** Full-bleed row placeholders matching inbox density. */
export function ListSkeleton({ count = 8 }: { count?: number }) {
  const { colors } = useTheme();
  return (
    <View>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.row, { borderBottomColor: colors.border }]}>
          <Skeleton width={40} height={40} borderRadius={12} />
          <View style={styles.rowMain}>
            <Skeleton width="40%" height={14} />
            <Skeleton width="70%" height={12} style={styles.gapSm} />
            <Skeleton width="55%" height={11} style={styles.gapSm} />
          </View>
          <Skeleton width={40} height={12} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  errorText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowMain: { flex: 1 },
  gapSm: { marginTop: 6 },
});
