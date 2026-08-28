import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { AlertCircle } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Skeleton } from '@weldsuite/mobile-ui/components/Skeleton';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { useI18n } from '@/lib/i18n';

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
  const { t } = useI18n();
  return (
    <View style={styles.center}>
      <AlertCircle size={40} color={colors.destructive} />
      <Text style={[styles.errorText, { color: colors.mutedForeground }]}>
        {message ?? t.common.somethingWentWrong}
      </Text>
      {onRetry ? (
        <Button title={t.common.tryAgain} variant="outline" size="sm" onPress={onRetry} loading={retrying} />
      ) : null}
    </View>
  );
}

export function ListSkeleton({ count = 8 }: { count?: number }) {
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
            <Skeleton width={48} height={12} />
          </View>
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
  rowSide: { alignItems: 'flex-end' },
  gapSm: { marginTop: 6 },
});
