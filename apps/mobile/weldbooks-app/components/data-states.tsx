/**
 * Loading / error / empty states.
 *
 * Every list and detail screen goes through these three so a failed request
 * always offers a retry instead of an empty screen, and loading always shows
 * skeletons in the shape of the content that is coming.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { AlertCircle } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Card } from '@weldsuite/mobile-ui/components/Card';
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
  message = 'Something went wrong.',
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
      <Text style={[styles.errorText, { color: colors.mutedForeground }]}>{message}</Text>
      {onRetry ? (
        <Button title="Try again" variant="outline" size="sm" onPress={onRetry} loading={retrying} />
      ) : null}
    </View>
  );
}

/** Card-shaped placeholder rows, matching the density of the list screens. */
export function ListSkeleton({ count = 6 }: { count?: number }) {
  const { colors } = useTheme();
  return (
    <View>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.row, { borderBottomColor: colors.border }]}>
          <Skeleton width={38} height={38} borderRadius={12} />
          <View style={styles.rowMain}>
            <Skeleton width="45%" height={14} />
            <Skeleton width="65%" height={11} style={styles.gapSm} />
          </View>
          <View style={styles.rowSide}>
            <Skeleton width={70} height={14} />
            <Skeleton width={54} height={16} borderRadius={8} style={styles.gapSm} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Full-width placeholder blocks for detail screens. */
export function DetailSkeleton() {
  return (
    <View style={styles.list}>
      <Card style={styles.block}>
        <Skeleton width="50%" height={20} />
        <Skeleton width="30%" height={12} style={styles.gapMd} />
        <Skeleton width="100%" height={1} style={styles.gapMd} />
        <Skeleton width="70%" height={14} style={styles.gapMd} />
        <Skeleton width="60%" height={14} style={styles.gapSm} />
      </Card>
      <Card style={styles.block}>
        <Skeleton width="40%" height={14} />
        <Skeleton width="100%" height={14} style={styles.gapMd} />
        <Skeleton width="80%" height={14} style={styles.gapSm} />
      </Card>
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
  list: { padding: 16, gap: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowMain: { flex: 1 },
  rowSide: { alignItems: 'flex-end' },
  block: { padding: 16 },
  gapSm: { marginTop: 6 },
  gapMd: { marginTop: 12 },
});
