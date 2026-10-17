/**
 * WeldBooks recurring invoice template: the detail read the object panel shows,
 * and the mutations on it (create, edit, generate now, pause, resume). The list
 * read lives in `use-accounting-queries.ts`; every mutation invalidates
 * `accountingKeys.recurring`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import type { GeneratedRecurringInvoice } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { accountingKeys } from './use-accounting-queries';

export function useRecurringInvoice(id: string) {
  return useQuery({
    queryKey: [...accountingKeys.recurring.all, 'detail', id] as const,
    queryFn: () => accountingApi.getRecurringInvoice(id),
    enabled: !!id,
  });
}

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

/** Issues the next invoice of the template now; the answer says whether it was finalized. */
export function useGenerateRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await accountingApi.generateRecurringInvoice(id)) as unknown as { data: GeneratedRecurringInvoice },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.recurring.all });
      qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
    },
  });
}

export function usePauseRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => accountingApi.pauseRecurringInvoice(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.recurring.all });
    },
  });
}

export function useResumeRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => accountingApi.resumeRecurringInvoice(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.recurring.all });
    },
  });
}
