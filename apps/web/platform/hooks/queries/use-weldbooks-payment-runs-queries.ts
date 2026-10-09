/**
 * WeldBooks vendor payment run queries and mutations (US).
 *
 * Keys live under `['accounting', 'payment-runs', ...]`, so the entity switch
 * resets them with the other entity-scoped accounting data
 * (`isEntityScopedAccountingQuery`): a run belongs to one entity.
 *
 * The check print data (blank stock carries the MICR line, which holds the
 * account number), the NACHA file and the Positive Pay file are never kept in
 * the query cache: they are read as one-shot actions or with `gcTime: 0`.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  paymentRunsApi,
  type CheckRegisterFilters,
  type CreateRunInput,
  type PayableBillsFilter,
  type PaymentRunDetail,
  type PositivePayFilters,
  type RunFilters,
  type UpdatePaymentSettingsInput,
  type UpdateRunInput,
  type VoidCheckInput,
} from '@/lib/api/domains/weldbooks-payment-runs';
import { accountingKeys } from './use-accounting-queries';

export const paymentRunKeys = {
  all: ['accounting', 'payment-runs'] as const,
  lists: () => [...paymentRunKeys.all, 'list'] as const,
  list: (filters?: RunFilters) => [...paymentRunKeys.all, 'list', filters ?? {}] as const,
  detail: (id: string) => [...paymentRunKeys.all, 'detail', id] as const,
  payable: (filters?: PayableBillsFilter) => [...paymentRunKeys.all, 'payable', filters ?? {}] as const,
  checkPrint: (id: string, all: boolean) => [...paymentRunKeys.all, 'check-print', id, all] as const,
  register: (filters?: CheckRegisterFilters) => [...paymentRunKeys.all, 'check-register', filters ?? {}] as const,
  positivePayFormats: () => [...paymentRunKeys.all, 'positive-pay-formats'] as const,
  settings: (bankAccountId: string) => [...paymentRunKeys.all, 'settings', bankAccountId] as const,
};

/** Approving a run makes payments, voiding a check reverses one: bills, payments and the ledger move. */
function invalidateBooks(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: accountingKeys.bills.all });
  qc.invalidateQueries({ queryKey: accountingKeys.payments.all });
  qc.invalidateQueries({ queryKey: accountingKeys.bankTransactions.all });
  qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
  qc.invalidateQueries({ queryKey: accountingKeys.accounts.all });
  qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
}

/** The run lists, the payable bills (a bill in a run is flagged) and the one run that changed. */
function invalidateRuns(qc: QueryClient, id?: string) {
  qc.invalidateQueries({ queryKey: paymentRunKeys.lists() });
  qc.invalidateQueries({ queryKey: [...paymentRunKeys.all, 'payable'] });
  if (id) qc.invalidateQueries({ queryKey: paymentRunKeys.detail(id) });
}

// ============================================================================
// Queries
// ============================================================================

export function usePaymentRuns(filters?: RunFilters, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: paymentRunKeys.list(filters),
    queryFn: () => paymentRunsApi.listRuns(filters),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function usePaymentRun(id: string | undefined) {
  return useQuery({
    queryKey: paymentRunKeys.detail(id ?? ''),
    queryFn: async () => (await paymentRunsApi.getRun(id!)).data,
    enabled: !!id,
  });
}

/** Approved bills with an open balance, by vendor. Pass `enabled: false` until a bank account is chosen. */
export function usePayableBills(filters: PayableBillsFilter, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: paymentRunKeys.payable(filters),
    queryFn: async () => (await paymentRunsApi.listPayableBills(filters)).data,
    enabled: options.enabled ?? true,
  });
}

/**
 * What the checks of a run print from. Never cached: blank stock carries the MICR line, and each
 * read of it decrypts the account number and is logged, so it is not refetched on focus either.
 */
export function useCheckPrintData(id: string | undefined, includePrinted: boolean) {
  return useQuery({
    queryKey: paymentRunKeys.checkPrint(id ?? '', includePrinted),
    queryFn: async () => (await paymentRunsApi.getCheckPrintData(id!, includePrinted)).data,
    enabled: !!id,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useCheckRegister(filters?: CheckRegisterFilters, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: paymentRunKeys.register(filters),
    queryFn: () => paymentRunsApi.getCheckRegister(filters),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function usePositivePayFormats() {
  return useQuery({
    queryKey: paymentRunKeys.positivePayFormats(),
    queryFn: async () => (await paymentRunsApi.listPositivePayFormats()).data,
    staleTime: 60 * 60 * 1000,
  });
}

export function usePaymentSettings(bankAccountId: string | undefined) {
  return useQuery({
    queryKey: paymentRunKeys.settings(bankAccountId ?? ''),
    queryFn: async () => (await paymentRunsApi.getSettings(bankAccountId!)).data,
    enabled: !!bankAccountId,
  });
}

// ============================================================================
// Mutations: runs
// ============================================================================

export function useCreatePaymentRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateRunInput) => (await paymentRunsApi.createRun(input)).data,
    onSuccess: (run) => {
      qc.setQueryData(paymentRunKeys.detail(run.id), run);
      invalidateRuns(qc);
    },
  });
}

export function useUpdatePaymentRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateRunInput }) => (await paymentRunsApi.updateRun(id, input)).data,
    onSuccess: (run) => {
      qc.setQueryData(paymentRunKeys.detail(run.id), run);
      invalidateRuns(qc, run.id);
    },
  });
}

export function useDeletePaymentRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => paymentRunsApi.deleteRun(id),
    onSuccess: () => invalidateRuns(qc),
  });
}

/** Submit, reject, cancel, release a hold and complete all answer with the refreshed run. */
function useRunTransition<TVars>(call: (vars: TVars) => Promise<{ data: PaymentRunDetail }>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: TVars) => (await call(vars)).data,
    onSuccess: (run) => {
      qc.setQueryData(paymentRunKeys.detail(run.id), run);
      invalidateRuns(qc, run.id);
    },
  });
}

export function useSubmitPaymentRun() {
  return useRunTransition((id: string) => paymentRunsApi.submitRun(id));
}

export function useRejectPaymentRun() {
  return useRunTransition(({ id, reason }: { id: string; reason: string }) => paymentRunsApi.rejectRun(id, reason));
}

export function useCancelPaymentRun() {
  return useRunTransition((id: string) => paymentRunsApi.cancelRun(id));
}

export function useReleaseRunHold() {
  return useRunTransition(({ id, partyId, reason }: { id: string; partyId: string; reason?: string }) =>
    paymentRunsApi.releaseHold(id, { partyId, reason }),
  );
}

export function useCompletePaymentRun() {
  return useRunTransition((id: string) => paymentRunsApi.completeRun(id));
}

/**
 * One approval. The last one makes the payments, so the books are refreshed
 * too. Calling it again on a run whose approvals are all in finishes an
 * interrupted approval.
 */
export function useApprovePaymentRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await paymentRunsApi.approveRun(id)).data,
    onSuccess: (result) => {
      qc.setQueryData(paymentRunKeys.detail(result.run.id), result.run);
      invalidateRuns(qc, result.run.id);
      if (result.approved) invalidateBooks(qc);
    },
  });
}

// ============================================================================
// Mutations: checks
// ============================================================================

export function useMarkChecksPrinted() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, paymentIds }: { id: string; paymentIds: string[] }) =>
      (await paymentRunsApi.markChecksPrinted(id, paymentIds)).data,
    onSuccess: (result) => {
      qc.setQueryData(paymentRunKeys.detail(result.run.id), result.run);
      invalidateRuns(qc, result.run.id);
      qc.invalidateQueries({ queryKey: [...paymentRunKeys.all, 'check-print'] });
      qc.invalidateQueries({ queryKey: [...paymentRunKeys.all, 'check-register'] });
    },
  });
}

/** Voids a check and, with `reissue`, writes the replacement under the next number. */
export function useVoidCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ paymentId, input }: { paymentId: string; input: VoidCheckInput }) =>
      (await paymentRunsApi.voidCheck(paymentId, input)).data,
    onSuccess: (result) => {
      invalidateRuns(qc, result.voided.runId ?? undefined);
      qc.invalidateQueries({ queryKey: [...paymentRunKeys.all, 'check-print'] });
      qc.invalidateQueries({ queryKey: [...paymentRunKeys.all, 'check-register'] });
      invalidateBooks(qc);
    },
  });
}

// ============================================================================
// Mutations: files (one-shot, never cached)
// ============================================================================

/** Makes the NACHA file. The run moves to `exported`, so the run is refreshed. */
export function useNachaFile() {
  const qc = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: async (id: string) => ({ id, file: (await paymentRunsApi.getNachaFile(id)).data }),
    onSuccess: ({ id }) => invalidateRuns(qc, id),
  });
}

export function usePositivePayFile() {
  return useMutation({
    gcTime: 0,
    mutationFn: async (filters: PositivePayFilters) => (await paymentRunsApi.getPositivePayFile(filters)).data,
  });
}

// ============================================================================
// Mutations: settings
// ============================================================================

export function useUpdatePaymentSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ bankAccountId, input }: { bankAccountId: string; input: UpdatePaymentSettingsInput }) =>
      (await paymentRunsApi.updateSettings(bankAccountId, input)).data,
    onSuccess: (settings) => {
      qc.setQueryData(paymentRunKeys.settings(settings.bankAccountId), settings);
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
    },
  });
}
