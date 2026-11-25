/**
 * WeldBooks annual reports (KvK jaarrekening): the list, one report and its
 * actions. Every action invalidates `annualReportKeys.all`, which covers the
 * list and the detail behind it. Filing and status checks also read the
 * report again, so the new status shows.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import type { AnnualReportPatch, AnnualReportSizeClass } from '@/lib/weldbooks/annual-report-model';

export const annualReportKeys = {
  all: ['accounting', 'annual-reports'] as const,
  list: (entityId: string | null) => [...annualReportKeys.all, 'list', entityId] as const,
  detail: (entityId: string | null, id: string) => [...annualReportKeys.all, 'detail', entityId, id] as const,
};

export function useAnnualReports() {
  const { entityId } = useCurrentAccountingEntity();
  return useQuery({
    queryKey: annualReportKeys.list(entityId),
    queryFn: () => accountingApi.listAnnualReports(),
  });
}

export function useAnnualReport(id: string) {
  const { entityId } = useCurrentAccountingEntity();
  return useQuery({
    queryKey: annualReportKeys.detail(entityId, id),
    queryFn: () => accountingApi.getAnnualReport(id),
    enabled: !!id,
  });
}

function useInvalidateAnnualReports() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: annualReportKeys.all });
}

export function useCreateAnnualReport() {
  const invalidate = useInvalidateAnnualReports();
  return useMutation({
    mutationFn: (data: { fiscalYear: number; sizeClass: AnnualReportSizeClass }) => accountingApi.createAnnualReport(data),
    onSuccess: invalidate,
  });
}

export function useUpdateAnnualReport(id: string) {
  const invalidate = useInvalidateAnnualReports();
  return useMutation({
    mutationFn: (data: AnnualReportPatch) => accountingApi.updateAnnualReport(id, data),
    onSuccess: invalidate,
  });
}

export function useRecalculateAnnualReport(id: string) {
  const invalidate = useInvalidateAnnualReports();
  return useMutation({
    mutationFn: () => accountingApi.recalculateAnnualReport(id),
    onSuccess: invalidate,
  });
}

/** Deposits the report with the KvK through Digipoort (needs the `kvk-digipoort` feature). */
export function useFileAnnualReport(id: string) {
  const invalidate = useInvalidateAnnualReports();
  return useMutation({
    mutationFn: () => accountingApi.fileAnnualReport(id),
    onSuccess: invalidate,
  });
}

/** Record that the report was deposited elsewhere, for example in the KvK's own portal. */
export function useMarkAnnualReportFiled(id: string) {
  const invalidate = useInvalidateAnnualReports();
  return useMutation({
    mutationFn: (data: { filingReference?: string; filedAt?: string }) => accountingApi.markAnnualReportFiled(id, data),
    onSuccess: invalidate,
  });
}

/** Asks Digipoort about a sent report, then reads the report again for its new status. */
export function useAnnualReportFilingStatus(id: string) {
  const invalidate = useInvalidateAnnualReports();
  return useMutation({
    mutationFn: () => accountingApi.getAnnualReportFilingStatus(id),
    onSuccess: invalidate,
  });
}

export function useDeleteAnnualReport(id: string) {
  const invalidate = useInvalidateAnnualReports();
  return useMutation({
    mutationFn: () => accountingApi.deleteAnnualReport(id),
    onSuccess: invalidate,
  });
}
