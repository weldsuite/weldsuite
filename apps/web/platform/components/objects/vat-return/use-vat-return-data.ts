/**
 * VAT return panel data hooks.
 *
 * The list reads (`useAccountingVatReturns`) live in `use-accounting-queries`;
 * this module adds the single-return read and the actions of the panel. Every
 * action invalidates `accountingKeys.vatReturns.all`, which covers the list
 * behind the panel and the detail this panel reads.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountingKeys } from '@/hooks/queries/use-accounting-queries';
import { accountingApi, type VatReturn } from '@/lib/api/domains/weldbooks';

export function useVatReturn(id: string) {
  return useQuery({
    queryKey: accountingKeys.vatReturns.detail(id),
    queryFn: () => accountingApi.getVatReturn(id),
    enabled: !!id,
  });
}

function useInvalidateVatReturns() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: accountingKeys.vatReturns.all });
}

export function useFileVatReturn(id: string) {
  const invalidate = useInvalidateVatReturns();
  return useMutation({
    mutationFn: () => accountingApi.fileVatReturn(id),
    onSuccess: invalidate,
  });
}

/** Record that the return was filed outside WeldSuite (no Digipoort on this edition). */
export function useMarkVatReturnFiled(id: string) {
  const invalidate = useInvalidateVatReturns();
  return useMutation({
    mutationFn: (data: { filingReference?: string; filedAt?: string }) => accountingApi.markVatReturnFiled(id, data),
    onSuccess: invalidate,
  });
}

export function useDeleteVatReturn(id: string) {
  const invalidate = useInvalidateVatReturns();
  return useMutation({
    mutationFn: () => accountingApi.deleteVatReturn(id),
    onSuccess: invalidate,
  });
}

/**
 * Calculate the return's period again: bookings made after the first calculation (a bill approved later,
 * a payment) are only in the return after this. The API updates the period's open return in place.
 */
export function useRecalculateVatReturn() {
  const invalidate = useInvalidateVatReturns();
  return useMutation({
    mutationFn: (vr: Pick<VatReturn, 'periodType' | 'periodStart' | 'periodEnd' | 'periodLabel'>) =>
      accountingApi.calculateVatReturn({
        periodType: vr.periodType === 'annual' ? 'yearly' : vr.periodType,
        periodStart: vr.periodStart.slice(0, 10),
        periodEnd: vr.periodEnd.slice(0, 10),
        periodLabel: vr.periodLabel || undefined,
      }),
    onSuccess: invalidate,
  });
}

export function useVatSuppletie(id: string) {
  const invalidate = useInvalidateVatReturns();
  return useMutation({
    mutationFn: () => accountingApi.createSuppletie(id),
    onSuccess: invalidate,
  });
}

export function useVatFilingStatus(id: string) {
  const invalidate = useInvalidateVatReturns();
  return useMutation({
    mutationFn: () => accountingApi.getVatFilingStatus(id),
    onSuccess: invalidate,
  });
}
