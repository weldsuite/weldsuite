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
import { accountingApi } from '@/lib/api/domains/weldbooks';

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

export function useDeleteVatReturn(id: string) {
  const invalidate = useInvalidateVatReturns();
  return useMutation({
    mutationFn: () => accountingApi.deleteVatReturn(id),
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
