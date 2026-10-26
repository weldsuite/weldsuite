import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Skeleton } from '@weldsuite/mobile-ui/components/Skeleton';

import { usePalette } from '@/hooks/use-palette';

import { ErrorState } from './Screen';

interface QueryLike<T> {
  isPending: boolean;
  isError: boolean;
  data: T | undefined;
  refetch?: () => unknown;
}

/** Row skeletons while loading, an error with a retry on failure, otherwise `children(data)`. */
export function QueryBody<T>({ query, children }: Readonly<{ query: QueryLike<T>; children: (data: T) => ReactNode }>) {
  if (query.isPending) return <ListSkeleton />;
  if (query.isError || query.data === undefined) {
    return <ErrorState onRetry={query.refetch ? () => void query.refetch?.() : undefined} />;
  }
  return <>{children(query.data)}</>;
}

/** Placeholders in the shape of the rows that are coming. */
export function ListSkeleton({ count = 5 }: Readonly<{ count?: number }>) {
  const palette = usePalette();
  return (
    <View style={styles.list}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.row, { borderBottomColor: palette.border }]}>
          <Skeleton width={40} height={40} borderRadius={11} />
          <View style={styles.main}>
            <Skeleton width="45%" height={14} />
            <Skeleton width="65%" height={11} style={styles.gap} />
          </View>
          <Skeleton width={54} height={16} borderRadius={8} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  main: { flex: 1 },
  gap: { marginTop: 6 },
});
