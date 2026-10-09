/**
 * WeldBooks fixed asset, payroll import, fiscal calendar and tax calendar
 * queries and mutations.
 *
 * Keys live under `['accounting', ...]`, so the entity switch resets them with
 * the other entity-scoped accounting data (`isEntityScopedAccountingQuery`):
 * an asset, a payroll import and a calendar all belong to one entity.
 *
 * Anything that posts to the ledger (the depreciation run, a disposal, a
 * payroll import, a reversal) also refreshes the journal, the accounts and the
 * reports. Nothing here keeps the Gusto access token: it only travels in the
 * mutation variables.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  fiscalCalendarApi,
  fixedAssetsApi,
  payrollApi,
  taxCalendarApi,
  type AccountMapping,
  type AssetFilters,
  type CompleteDeadlineInput,
  type CreateAssetInput,
  type CreateGustoConnectionInput,
  type CsvImportInput,
  type DeMinimisInput,
  type DisposeInput,
  type FiscalCalendarParams,
  type FromBillLineInput,
  type GustoSyncInput,
  type PayrollImportFilters,
  type RegisterParams,
  type TaxDepreciationParams,
  type UpdateAssetInput,
} from '@/lib/api/domains/weldbooks-assets';
import { accountingKeys } from './use-accounting-queries';

export const fixedAssetKeys = {
  all: ['accounting', 'fixed-assets'] as const,
  lists: () => [...fixedAssetKeys.all, 'list'] as const,
  list: (filters?: AssetFilters) => [...fixedAssetKeys.all, 'list', filters ?? {}] as const,
  detail: (id: string) => [...fixedAssetKeys.all, 'detail', id] as const,
  register: (params?: RegisterParams) => [...fixedAssetKeys.all, 'register', params ?? {}] as const,
  taxDepreciation: (params?: TaxDepreciationParams) => [...fixedAssetKeys.all, 'tax-depreciation', params ?? {}] as const,
  deMinimis: (input: DeMinimisInput) => [...fixedAssetKeys.all, 'de-minimis', input] as const,
};

export const payrollKeys = {
  all: ['accounting', 'payroll'] as const,
  imports: () => [...payrollKeys.all, 'imports'] as const,
  importList: (filters?: PayrollImportFilters) => [...payrollKeys.all, 'imports', 'list', filters ?? {}] as const,
  importDetail: (id: string) => [...payrollKeys.all, 'imports', 'detail', id] as const,
  categories: () => [...payrollKeys.all, 'categories'] as const,
  csvMapping: () => [...payrollKeys.all, 'csv-mapping'] as const,
  connections: () => [...payrollKeys.all, 'connections'] as const,
};

/** Under the prefix the realtime sync map resets on a `fiscal_period` event. */
export const fiscalCalendarKeys = {
  all: ['accounting', 'fiscal-periods', 'calendar'] as const,
  year: (params: FiscalCalendarParams) => [...fiscalCalendarKeys.all, params] as const,
};

export const taxCalendarKeys = {
  all: ['accounting', 'tax-calendar'] as const,
  year: (year?: number) => [...taxCalendarKeys.all, year ?? 'current'] as const,
};

/** Depreciation, disposals and payroll write journal entries: the ledger, the accounts and the reports move. */
function invalidateLedger(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
  qc.invalidateQueries({ queryKey: accountingKeys.accounts.all });
  qc.invalidateQueries({ queryKey: accountingKeys.reports.all });
  qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
}

// ============================================================================
// Fixed assets
// ============================================================================

export function useFixedAssets(filters?: AssetFilters, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: fixedAssetKeys.list(filters),
    queryFn: () => fixedAssetsApi.list(filters),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useFixedAsset(id: string | undefined) {
  return useQuery({
    queryKey: fixedAssetKeys.detail(id ?? ''),
    queryFn: async () => (await fixedAssetsApi.get(id!)).data,
    enabled: !!id,
  });
}

/** The register as of a date (totals of cost, accumulated depreciation and net book value). */
export function useFixedAssetRegister(params?: RegisterParams, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: fixedAssetKeys.register(params),
    queryFn: async () => (await fixedAssetsApi.register(params)).data,
    enabled: options.enabled ?? true,
  });
}

/** Form 4562 style report plus the mid-quarter test of the year. US only. */
export function useTaxDepreciationReport(params?: TaxDepreciationParams, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: fixedAssetKeys.taxDepreciation(params),
    queryFn: async () => (await fixedAssetsApi.taxDepreciation(params)).data,
    enabled: options.enabled ?? true,
  });
}

/** Expense or capitalize: a read-only check run as a POST, so it is keyed by what was asked. */
export function useDeMinimisAdvice(input: DeMinimisInput, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: fixedAssetKeys.deMinimis(input),
    queryFn: async () => (await fixedAssetsApi.deMinimisCheck(input)).data,
    enabled: options.enabled ?? true,
    staleTime: 5 * 60 * 1000,
  });
}

function invalidateAssets(qc: QueryClient, id?: string) {
  qc.invalidateQueries({ queryKey: fixedAssetKeys.lists() });
  qc.invalidateQueries({ queryKey: [...fixedAssetKeys.all, 'register'] });
  qc.invalidateQueries({ queryKey: [...fixedAssetKeys.all, 'tax-depreciation'] });
  if (id) qc.invalidateQueries({ queryKey: fixedAssetKeys.detail(id) });
}

export function useCreateFixedAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAssetInput) => (await fixedAssetsApi.create(input)).data,
    onSuccess: () => invalidateAssets(qc),
  });
}

/** Creates the asset from a bill line; with `reclass` it also posts the entry that moves the cost. */
export function useCreateFixedAssetFromBillLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: FromBillLineInput) => (await fixedAssetsApi.fromBillLine(input)).data,
    onSuccess: (_result, input) => {
      invalidateAssets(qc);
      if (input.reclass) invalidateLedger(qc);
      qc.invalidateQueries({ queryKey: accountingKeys.bills.all });
    },
  });
}

export function useUpdateFixedAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateAssetInput }) => (await fixedAssetsApi.update(id, input)).data,
    onSuccess: (_result, { id }) => invalidateAssets(qc, id),
  });
}

export function useDeleteFixedAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fixedAssetsApi.remove(id),
    onSuccess: (_result, id) => {
      invalidateAssets(qc);
      qc.removeQueries({ queryKey: fixedAssetKeys.detail(id) });
    },
  });
}

export function useDisposeFixedAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: DisposeInput }) => (await fixedAssetsApi.dispose(id, input)).data,
    onSuccess: (_result, { id }) => {
      invalidateAssets(qc, id);
      invalidateLedger(qc);
    },
  });
}

export function useRunDepreciation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (through: string) => (await fixedAssetsApi.runDepreciation(through)).data,
    onSuccess: () => {
      invalidateAssets(qc);
      qc.invalidateQueries({ queryKey: [...fixedAssetKeys.all, 'detail'] });
      invalidateLedger(qc);
    },
  });
}

// ============================================================================
// Payroll
// ============================================================================

export function usePayrollImports(filters?: PayrollImportFilters, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: payrollKeys.importList(filters),
    queryFn: () => payrollApi.listImports(filters),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function usePayrollImport(id: string | undefined) {
  return useQuery({
    queryKey: payrollKeys.importDetail(id ?? ''),
    queryFn: async () => (await payrollApi.getImport(id!)).data,
    enabled: !!id,
  });
}

export function usePayrollCategories() {
  return useQuery({
    queryKey: payrollKeys.categories(),
    queryFn: async () => (await payrollApi.listCategories()).data,
    staleTime: 60 * 60 * 1000,
  });
}

/** The entity's saved CSV mapping, or null when none was saved. */
export function usePayrollCsvMapping(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: payrollKeys.csvMapping(),
    queryFn: async () => (await payrollApi.getCsvMapping()).data,
    enabled: options.enabled ?? true,
  });
}

/**
 * Dry run (`dryRun: true`) validates the file and builds the entries without
 * posting; the real import posts one entry per payroll.
 */
export function useImportPayrollCsv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CsvImportInput) => (await payrollApi.importCsv(input)).data,
    onSuccess: (_result, input) => {
      if (input.dryRun) return;
      qc.invalidateQueries({ queryKey: payrollKeys.imports() });
      if (input.saveMapping) qc.invalidateQueries({ queryKey: payrollKeys.csvMapping() });
      invalidateLedger(qc);
    },
  });
}

export function useReversePayrollImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, date }: { id: string; date?: string }) => (await payrollApi.reverseImport(id, date)).data,
    onSuccess: (_result, { id }) => {
      qc.invalidateQueries({ queryKey: payrollKeys.imports() });
      qc.invalidateQueries({ queryKey: payrollKeys.importDetail(id) });
      invalidateLedger(qc);
    },
  });
}

export function usePayrollConnections(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: payrollKeys.connections(),
    queryFn: async () => (await payrollApi.listConnections()).data,
    enabled: options.enabled ?? true,
  });
}

export function useCreateGustoConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateGustoConnectionInput) => (await payrollApi.createConnection(input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: payrollKeys.connections() }),
  });
}

export function useSetPayrollConnectionMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, accountMapping }: { id: string; accountMapping: AccountMapping }) =>
      (await payrollApi.setConnectionMapping(id, accountMapping)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: payrollKeys.connections() }),
  });
}

export function useSyncPayrollConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input?: GustoSyncInput }) =>
      (await payrollApi.syncConnection(id, input)).data,
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: payrollKeys.connections() });
      if (result.imported.length > 0) {
        qc.invalidateQueries({ queryKey: payrollKeys.imports() });
        invalidateLedger(qc);
      }
    },
  });
}

export function useDisconnectPayrollConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => payrollApi.disconnect(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: payrollKeys.connections() }),
  });
}

// ============================================================================
// Fiscal calendar
// ============================================================================

export function useFiscalCalendar(params: FiscalCalendarParams, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: fiscalCalendarKeys.year(params),
    queryFn: async () => (await fiscalCalendarApi.calendar(params)).data,
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useGenerateFiscalPeriods() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: FiscalCalendarParams) => (await fiscalCalendarApi.generate(params)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: fiscalCalendarKeys.all }),
  });
}

// ============================================================================
// Tax calendar (US)
// ============================================================================

export function useTaxCalendar(year?: number, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: taxCalendarKeys.year(year),
    queryFn: async () => (await taxCalendarApi.get(year)).data,
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useCompleteDeadline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CompleteDeadlineInput) => (await taxCalendarApi.complete(input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: taxCalendarKeys.all }),
  });
}

export function useReopenDeadline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deadlineKey: string) => taxCalendarApi.reopen(deadlineKey),
    onSuccess: () => qc.invalidateQueries({ queryKey: taxCalendarKeys.all }),
  });
}
