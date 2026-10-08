/**
 * WeldBooks recurring invoice mutations (create and edit a template). The list
 * and detail reads live in `use-accounting-queries.ts`; both invalidate
 * `accountingKeys.recurring`.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { accountingKeys } from './use-accounting-queries';

export function useCreateRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => accountingApi.createRecurringInvoice(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.recurring.all });
    },
  });
}

export function useUpdateRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      accountingApi.updateRecurringInvoice(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.recurring.all });
    },
  });
}
