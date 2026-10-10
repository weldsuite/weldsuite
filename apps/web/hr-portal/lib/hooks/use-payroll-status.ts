'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { portalGet } from '@/lib/client';
import { portalQueryKey } from '@/lib/query-client';
import type { HrMyPayrollDetails } from '@/lib/payroll/types';

export const PAYROLL_DETAILS_PATH = '/employee/payroll-details';

/**
 * The navigation's own cache entry for the payroll details. It must not share
 * the payroll page's key: the page hands its server-loaded data to the browser
 * through `HydrationBoundary`, which skips a query that already exists in the
 * cache while it renders, and the navigation (rendered first) would be that
 * query, leaving the page to fetch for itself during server rendering.
 * `invalidatePortal` still matches it by path.
 */
function statusKey(slug: string) {
  return portalQueryKey(slug, PAYROLL_DETAILS_PATH, { use: 'navigation' });
}

export interface PayrollStatus {
  /** The workspace has payroll switched on (the details call succeeded; it 404s otherwise). */
  available: boolean;
  details: HrMyPayrollDetails | null;
  /** The employee is on payroll and still has details to add or a tax form to sign. */
  needsAttention: boolean;
}

/**
 * Whether the signed-in employee has a payroll section, and whether it needs
 * them. `GET /employee/payroll-details` answers 404 when the workspace has not
 * enabled payroll, so any failure here simply means "no payroll navigation".
 *
 * Not suspense-based on purpose: the navigation must never block on, or break
 * because of, payroll.
 */
export function usePayrollStatus(slug: string, enabled: boolean): PayrollStatus {
  const query = useQuery({
    queryKey: statusKey(slug),
    queryFn: () => portalGet<HrMyPayrollDetails>(slug, PAYROLL_DETAILS_PATH),
    enabled,
    // A 404 will not turn into a 200 by itself: don't ask again on every focus.
    refetchOnWindowFocus: (q) => q.state.status !== 'error',
  });
  const details = query.data ?? null;
  const onPayroll = details !== null && details.country !== null;
  return {
    available: details !== null,
    details,
    needsAttention: onPayroll && (details.missing.length > 0 || details.requiredElections.length > 0),
  };
}

/**
 * Puts a fresh `HrMyPayrollDetails` (the answer to a save or a signature)
 * straight into the cache, for the page and for the navigation.
 */
export function useSetPayrollDetails(slug: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (details: HrMyPayrollDetails) => {
      queryClient.setQueryData<HrMyPayrollDetails>(portalQueryKey(slug, PAYROLL_DETAILS_PATH), details);
      queryClient.setQueryData<HrMyPayrollDetails>(statusKey(slug), details);
    },
    [queryClient, slug],
  );
}
