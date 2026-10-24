/**
 * My HR screens need two things: the `employees:self` permission and an
 * employee record linked to the signed-in member. Without either there is
 * nothing to show, so say why instead of rendering empty lists.
 */

import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { UserRoundX } from 'lucide-react-native';
import { isApiError } from '@weldsuite/api-client/client';
import type { HrSelf, HrSelfProfile } from '@weldsuite/app-api-client/domains/weldhr';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { useHrAccess, useMe } from '@/hooks/use-weldhr-queries';
import { useI18n } from '@/lib/i18n';
import { ErrorNote } from './Screen';

export type LinkedSelf = HrSelf & { employee: HrSelfProfile };

export type SelfState =
  | { status: 'loading' }
  | { status: 'no-access' }
  | { status: 'not-linked' }
  | { status: 'error' }
  | { status: 'ready'; self: LinkedSelf };

export function useSelfState(): SelfState & { refetch: () => void; isRefetching: boolean } {
  const { access, isLoading } = useHrAccess();
  const me = useMe();
  const base = { refetch: () => void me.refetch(), isRefetching: me.isRefetching };

  if (me.isPending || (isLoading && !me.data)) return { status: 'loading', ...base };
  if (me.isError) {
    // A 403 is the API saying "no My HR for you"; the permission list agrees
    // unless a role changed a moment ago.
    const forbidden = isApiError(me.error) && me.error.status === 403;
    return { status: forbidden || !access.self ? 'no-access' : 'error', ...base };
  }
  const { employee } = me.data;
  if (!employee) return { status: 'not-linked', ...base };
  return { status: 'ready', self: { ...me.data, employee }, ...base };
}

export function MyHrGate({ state, children }: Readonly<{ state: SelfState; children: ReactNode }>) {
  const { colors } = useTheme();
  const { t } = useI18n();

  switch (state.status) {
    case 'loading':
      return (
        <View style={styles.center}>
          <ActivityIndicator color={colors.text} />
        </View>
      );
    case 'no-access':
      return (
        <EmptyState
          icon={<UserRoundX size={36} color={colors.mutedForeground} />}
          title={t.notLinked.noAccessTitle}
          description={t.notLinked.noAccessDescription}
        />
      );
    case 'not-linked':
      return (
        <EmptyState
          icon={<UserRoundX size={36} color={colors.mutedForeground} />}
          title={t.notLinked.title}
          description={t.notLinked.description}
        />
      );
    case 'error':
      return <ErrorNote message={t.common.somethingWrong} />;
    default:
      return <>{children}</>;
  }
}

const styles = StyleSheet.create({
  center: { paddingVertical: 48, alignItems: 'center' },
});
