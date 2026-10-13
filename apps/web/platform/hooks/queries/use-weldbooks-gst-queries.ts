/**
 * India GST return worksheet query. The key sits under `['accounting']`, so
 * switching the accounting entity resets it with the other entity-scoped data.
 */
import { useQuery } from '@tanstack/react-query';
import { gstReturnApi } from '@/lib/api/domains/weldbooks-gst';
import { isValidPeriod, type GstPeriod } from '@/lib/weldbooks/gst-periods';

export const gstKeys = {
  all: ['accounting', 'gst-worksheet'] as const,
  worksheet: (period: GstPeriod) => [...gstKeys.all, period.periodStart, period.periodEnd] as const,
};

/** The GSTR-1 / GSTR-3B summary of `period`, for the selected entity. */
export function useGstWorksheet(period: GstPeriod, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: gstKeys.worksheet(period),
    enabled: (options.enabled ?? true) && isValidPeriod(period),
    queryFn: async () => (await gstReturnApi.worksheet(period.periodStart, period.periodEnd)).data,
    retry: false,
  });
}
