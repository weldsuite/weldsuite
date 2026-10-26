/**
 * My HR screens need two things: the `employees:self` permission and an
 * employee record linked to the signed-in member. Without either there is
 * nothing to show, so say why instead of rendering empty lists.
 */

import type { ReactNode } from 'react';
import { isApiError } from '@weldsuite/api-client/client';
import type { HrSelf, HrSelfProfile } from '@weldsuite/app-api-client/domains/weldhr';

import { useHrAccess, useMe } from '@/hooks/use-weldhr-queries';
import { useI18n } from '@/lib/i18n';
import { EmptyState } from './EmptyState';
import { ListSkeleton } from './QueryBody';
import { ErrorState } from './Screen';

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

export function MyHrGate({
  state,
  onRetry,
  children,
}: Readonly<{ state: SelfState; onRetry?: () => void; children: ReactNode }>) {
  const { t } = useI18n();

  switch (state.status) {
    case 'loading':
      return <ListSkeleton count={4} />;
    case 'no-access':
      return <EmptyState illustration="person" title={t.notLinked.noAccessTitle} description={t.notLinked.noAccessDescription} />;
    case 'not-linked':
      return <EmptyState illustration="person" title={t.notLinked.title} description={t.notLinked.description} />;
    case 'error':
      return <ErrorState onRetry={onRetry} />;
    default:
      return <>{children}</>;
  }
}
