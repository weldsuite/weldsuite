/**
 * WeldBooks US Sales Tax Center queries and mutations: periods, returns and
 * their flow, the sales tax reports, the certificate reports and the nexus
 * monitor.
 *
 * Keys live under `['accounting', 'sales-tax-center', ...]`, so the entity
 * switch resets them with the other entity-scoped accounting data
 * (`isEntityScopedAccountingQuery`): a return belongs to one entity.
 */
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  salesTaxCenterApi,
  type CreateReturnInput,
  type FileReturnInput,
  type PaymentInput,
  type PeriodsFilter,
  type SalesSummaryGroup,
  type UpdateReturnInput,
} from '@/lib/api/domains/weldbooks-sales-tax-center';
import { accountingKeys } from './use-accounting-queries';

export const salesTaxKeys = {
  all: ['accounting', 'sales-tax-center'] as const,
  overview: () => [...salesTaxKeys.all, 'overview'] as const,
  periods: (filter?: PeriodsFilter) => [...salesTaxKeys.all, 'periods', filter ?? {}] as const,
  returns: {
    all: [...(['accounting', 'sales-tax-center', 'returns'] as const)],
    detail: (id: string) => [...salesTaxKeys.returns.all, 'detail', id] as const,
    documents: (id: string) => [...salesTaxKeys.returns.all, 'documents', id] as const,
    preFile: (id: string) => [...salesTaxKeys.returns.all, 'pre-file', id] as const,
    liability: (id: string) => [...salesTaxKeys.returns.all, 'liability', id] as const,
    exceptions: (id: string) => [...salesTaxKeys.returns.all, 'exceptions', id] as const,
  },
  reports: {
    all: [...(['accounting', 'sales-tax-center', 'reports'] as const)],
    liability: (asOf?: string) => [...salesTaxKeys.reports.all, 'liability', asOf ?? 'today'] as const,
    salesSummary: (params: { from?: string; to?: string; groupBy?: SalesSummaryGroup }) =>
      [...salesTaxKeys.reports.all, 'sales-summary', params] as const,
    exceptions: (params: { from?: string; to?: string }) => [...salesTaxKeys.reports.all, 'exceptions', params] as const,
    expiring: (days?: number) => [...salesTaxKeys.reports.all, 'expiring', days ?? 60] as const,
    missing: (params: { from?: string; to?: string }) => [...salesTaxKeys.reports.all, 'missing', params] as const,
    providerReconciliation: (params: { from?: string; to?: string; all?: boolean }) =>
      [...salesTaxKeys.reports.all, 'provider-reconciliation', params] as const,
  },
  nexus: {
    all: [...(['accounting', 'sales-tax-center', 'nexus'] as const)],
    overview: (asOf?: string) => [...salesTaxKeys.nexus.all, 'overview', asOf ?? 'today'] as const,
    detail: (stateCode: string, asOf?: string) => [...salesTaxKeys.nexus.all, 'detail', stateCode, asOf ?? 'today'] as const,
  },
};

/** What a change to one return moves: the return itself, its checks and the entry views of the Center. */
function invalidateReturn(qc: QueryClient, id: string) {
  qc.invalidateQueries({ queryKey: salesTaxKeys.returns.detail(id) });
  qc.invalidateQueries({ queryKey: salesTaxKeys.returns.documents(id) });
  qc.invalidateQueries({ queryKey: salesTaxKeys.returns.preFile(id) });
  qc.invalidateQueries({ queryKey: salesTaxKeys.returns.liability(id) });
  qc.invalidateQueries({ queryKey: salesTaxKeys.returns.exceptions(id) });
  qc.invalidateQueries({ queryKey: salesTaxKeys.overview() });
  qc.invalidateQueries({ queryKey: [...salesTaxKeys.all, 'periods'] });
}

/** Filing and payment move the liability: the reports that read the payable follow. */
function invalidateLiability(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: salesTaxKeys.reports.all });
}

/** Paying a return posts a journal entry against the bank and the agency's payable account. */
function invalidateBooks(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
  qc.invalidateQueries({ queryKey: accountingKeys.bankTransactions.all });
  qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
  qc.invalidateQueries({ queryKey: accountingKeys.accounts.all });
  qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
}

// ============================================================================
// Periods, overview, returns
// ============================================================================

export function useSalesTaxOverview(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesTaxKeys.overview(),
    queryFn: () => salesTaxCenterApi.getOverview(),
    enabled: options.enabled ?? true,
  });
}

export function useSalesTaxPeriods(filter?: PeriodsFilter, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesTaxKeys.periods(filter),
    queryFn: () => salesTaxCenterApi.getPeriods(filter),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useTaxReturn(id: string | undefined) {
  return useQuery({
    queryKey: salesTaxKeys.returns.detail(id ?? ''),
    queryFn: () => salesTaxCenterApi.getReturn(id!),
    enabled: !!id,
  });
}

/** The documents behind a return, a page at a time (the server pages with an offset cursor). */
export function useReturnDocuments(id: string | undefined, options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: salesTaxKeys.returns.documents(id ?? ''),
    queryFn: ({ pageParam }) => salesTaxCenterApi.listReturnDocuments(id!, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    enabled: !!id && (options.enabled ?? true),
  });
}

export function usePreFileCheck(id: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesTaxKeys.returns.preFile(id ?? ''),
    queryFn: () => salesTaxCenterApi.getPreFileCheck(id!),
    enabled: !!id && (options.enabled ?? true),
  });
}

export function useLiabilityCheck(id: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesTaxKeys.returns.liability(id ?? ''),
    queryFn: () => salesTaxCenterApi.getLiabilityCheck(id!),
    enabled: !!id && (options.enabled ?? true),
  });
}

export function useReturnExceptions(id: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesTaxKeys.returns.exceptions(id ?? ''),
    queryFn: () => salesTaxCenterApi.getExceptions(id!),
    enabled: !!id && (options.enabled ?? true),
  });
}

// ============================================================================
// Return mutations
// ============================================================================

export function useCreateTaxReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateReturnInput) => salesTaxCenterApi.createReturn(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: salesTaxKeys.overview() });
      qc.invalidateQueries({ queryKey: [...salesTaxKeys.all, 'periods'] });
    },
  });
}

export function useUpdateTaxReturn(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateReturnInput) => salesTaxCenterApi.updateReturn(id, input),
    onSuccess: () => invalidateReturn(qc, id),
  });
}

export function useDeleteTaxReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => salesTaxCenterApi.deleteReturn(id),
    onSuccess: (_result, id) => {
      qc.removeQueries({ queryKey: salesTaxKeys.returns.detail(id) });
      qc.invalidateQueries({ queryKey: salesTaxKeys.overview() });
      qc.invalidateQueries({ queryKey: [...salesTaxKeys.all, 'periods'] });
    },
  });
}

export function useCalculateTaxReturn(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => salesTaxCenterApi.calculateReturn(id),
    onSuccess: () => invalidateReturn(qc, id),
  });
}

export function useReviewTaxReturn(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => salesTaxCenterApi.reviewReturn(id),
    onSuccess: () => invalidateReturn(qc, id),
  });
}

export function useFileTaxReturn(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: FileReturnInput) => salesTaxCenterApi.fileReturn(id, input),
    onSuccess: () => {
      invalidateReturn(qc, id);
      invalidateLiability(qc);
    },
  });
}

export function usePayTaxReturn(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PaymentInput) => salesTaxCenterApi.payReturn(id, input),
    onSuccess: () => {
      invalidateReturn(qc, id);
      invalidateLiability(qc);
      invalidateBooks(qc);
    },
  });
}

export function useAmendTaxReturn(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => salesTaxCenterApi.amendReturn(id),
    onSuccess: () => {
      invalidateReturn(qc, id);
    },
  });
}

export function useCarryForwardExceptions(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taxLineIds?: string[]) => salesTaxCenterApi.carryForward(id, taxLineIds),
    onSuccess: () => invalidateReturn(qc, id),
  });
}

// ============================================================================
// Reports
// ============================================================================

export function useSalesTaxLiabilityReport(asOf?: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesTaxKeys.reports.liability(asOf),
    queryFn: () => salesTaxCenterApi.getLiabilityReport(asOf),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useSalesSummaryReport(
  params: { from?: string; to?: string; groupBy?: SalesSummaryGroup },
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: salesTaxKeys.reports.salesSummary(params),
    queryFn: () => salesTaxCenterApi.getSalesSummary(params),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useSalesTaxExceptionsReport(params: { from?: string; to?: string }, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesTaxKeys.reports.exceptions(params),
    queryFn: () => salesTaxCenterApi.getExceptionsReport(params),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useExpiringCertificatesReport(days?: number, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesTaxKeys.reports.expiring(days),
    queryFn: () => salesTaxCenterApi.getExpiringCertificates(days),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useMissingCertificatesReport(params: { from?: string; to?: string }, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesTaxKeys.reports.missing(params),
    queryFn: () => salesTaxCenterApi.getMissingCertificates(params),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useProviderReconciliation(
  params: { from?: string; to?: string; all?: boolean },
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: salesTaxKeys.reports.providerReconciliation(params),
    queryFn: () => salesTaxCenterApi.getProviderReconciliation(params),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

// ============================================================================
// Nexus
// ============================================================================

export function useNexusOverview(asOf?: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesTaxKeys.nexus.overview(asOf),
    queryFn: () => salesTaxCenterApi.getNexusOverview(asOf),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useNexusDetail(stateCode: string | undefined, asOf?: string) {
  return useQuery({
    queryKey: salesTaxKeys.nexus.detail(stateCode ?? '', asOf),
    queryFn: () => salesTaxCenterApi.getNexusDetail(stateCode!, asOf),
    enabled: !!stateCode,
  });
}
