import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { useI18n } from '@/lib/i18n';
import { ErrorNote } from './Screen';

interface QueryLike<T> {
  isPending: boolean;
  isError: boolean;
  data: T | undefined;
}

/** Spinner while loading, a short error on failure, otherwise `children(data)`. */
export function QueryBody<T>({ query, children }: Readonly<{ query: QueryLike<T>; children: (data: T) => ReactNode }>) {
  const { t } = useI18n();
  if (query.isPending) return <ActivityIndicator style={styles.loading} />;
  if (query.isError || query.data === undefined) return <ErrorNote message={t.common.somethingWrong} />;
  return <>{children(query.data)}</>;
}

const styles = StyleSheet.create({
  loading: { marginTop: 32 },
});
