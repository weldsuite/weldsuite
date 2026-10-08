import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  bankingApi,
  type BankAccountType,
  type BankLineFilters,
  type CompleteReconciliationInput,
  type CreateDepositInput,
  type DepositFilters,
  type ImportPreviewInput,
  type ImportStatementInput,
  type ReconciliationHistoryFilters,
  type RecordInvoicePaymentWithTarget,
  type SaveBankAccountInput,
  type SaveReconciliationProgressInput,
  type StartReconciliationInput,
} from '@/lib/api/domains/weldbooks-banking';
import { accountingKeys } from './use-accounting-queries';

// ============================================================================
// Query keys
//
// Every key sits under ['accounting', ...], so switching the accounting entity
// resets them with the rest of the entity-scoped accounting data.
// ============================================================================

export const bankingKeys = {
  lines: {
    all: [...accountingKeys.bankTransactions.all, 'lines'] as const,
    list: (filters?: BankLineFilters) => [...accountingKeys.bankTransactions.all, 'lines', filters] as const,
    suggestions: (id: string) => [...accountingKeys.bankTransactions.all, 'suggestions', id] as const,
  },
  importPreview: (parts: readonly unknown[]) => [...accountingKeys.bankTransactions.all, 'import-preview', ...parts] as const,
  deposits: {
    all: ['accounting', 'bank-deposits'] as const,
    undeposited: () => ['accounting', 'bank-deposits', 'undeposited'] as const,
    list: (filters?: DepositFilters) => ['accounting', 'bank-deposits', 'list', filters] as const,
    detail: (id: string) => ['accounting', 'bank-deposits', 'detail', id] as const,
  },
  reconciliations: {
    all: ['accounting', 'bank-reconciliations'] as const,
    list: (filters?: ReconciliationHistoryFilters) => ['accounting', 'bank-reconciliations', 'list', filters] as const,
    detail: (id: string) => ['accounting', 'bank-reconciliations', 'detail', id] as const,
    report: (id: string) => ['accounting', 'bank-reconciliations', 'report', id] as const,
  },
};

/** What a change to the bank books touches besides the bank rows themselves. */
function invalidateLedger(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
  qc.invalidateQueries({ queryKey: accountingKeys.accounts.all });
  qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
}

// ============================================================================
// Bank accounts
// ============================================================================

export function useBankAccounts(
  filters?: { accountType?: BankAccountType; isActive?: boolean },
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: filters ? [...accountingKeys.bankAccounts.list(), filters] : accountingKeys.bankAccounts.list(),
    queryFn: () => bankingApi.listBankAccounts(filters),
    enabled: options.enabled ?? true,
  });
}

export function useBankAccount(id: string | undefined) {
  return useQuery({
    queryKey: accountingKeys.bankAccounts.detail(id ?? ''),
    queryFn: () => bankingApi.getBankAccount(id!),
    enabled: !!id,
  });
}

export function useCreateBankAccountWithDetails() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: SaveBankAccountInput) => bankingApi.createBankAccount(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
      // A new ledger account may have been created with it.
      qc.invalidateQueries({ queryKey: accountingKeys.accounts.all });
      qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
    },
  });
}

export function useUpdateBankAccountWithDetails() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<SaveBankAccountInput> }) =>
      bankingApi.updateBankAccount(id, data),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.detail(id) });
    },
  });
}

/**
 * Reveals the full account number. The result is never cached: the mutation
 * is dropped as soon as the component stops observing it.
 */
export function useRevealAccountNumber() {
  return useMutation({
    gcTime: 0,
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => bankingApi.revealAccountNumber(id, reason),
  });
}

// ============================================================================
// Statement import
// ============================================================================

/** A short stable key for a (possibly large) file, so it can sit in a query key. */
export function contentKey(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

/**
 * Reads a statement file without importing it. Pass `null` until a file and a
 * bank account are chosen. Changing the CSV format re-reads the file and keeps
 * the previous result on screen meanwhile.
 */
export function useBankImportPreview(input: ImportPreviewInput | null) {
  return useQuery({
    queryKey: bankingKeys.importPreview([
      input?.bankAccountId ?? null,
      input?.fileName ?? null,
      input ? contentKey(input.content) : null,
      input?.format ?? null,
      input?.csvFormat ? JSON.stringify(input.csvFormat) : null,
    ]),
    queryFn: async () => (await bankingApi.previewImport(input!)).data,
    enabled: input !== null,
    retry: false,
    staleTime: 60_000,
    gcTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useImportBankStatement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ImportStatementInput) => bankingApi.importStatement(data).then((res) => res.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.bankTransactions.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
      // Auto-reconciliation may have recorded payments.
      qc.invalidateQueries({ queryKey: accountingKeys.payments.all });
      qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bills.all });
      invalidateLedger(qc);
    },
  });
}

// ============================================================================
// Bank lines and matching
// ============================================================================

export function useBankLines(filters?: BankLineFilters) {
  return useQuery({
    queryKey: bankingKeys.lines.list(filters),
    queryFn: () => bankingApi.listBankLines(filters),
  });
}

export function useBankLineSuggestions(id: string | null) {
  return useQuery({
    queryKey: bankingKeys.lines.suggestions(id ?? ''),
    queryFn: async () => (await bankingApi.getSuggestions(id!)).data,
    enabled: !!id,
  });
}

function invalidateAfterMatch(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: accountingKeys.bankTransactions.all });
  qc.invalidateQueries({ queryKey: accountingKeys.payments.all });
  qc.invalidateQueries({ queryKey: bankingKeys.deposits.all });
  invalidateLedger(qc);
}

export function useMatchBankLineToPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, paymentId }: { lineId: string; paymentId: string }) =>
      bankingApi.matchPayment(lineId, paymentId),
    onSuccess: () => invalidateAfterMatch(qc),
  });
}

export function useMatchBankLineToDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, depositId }: { lineId: string; depositId: string }) =>
      bankingApi.matchDeposit(lineId, depositId),
    onSuccess: () => invalidateAfterMatch(qc),
  });
}

// ============================================================================
// Payments
// ============================================================================

/** Record a payment against an invoice, choosing between Undeposited Funds and a bank account. */
export function useRecordInvoicePaymentWithTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: RecordInvoicePaymentWithTarget }) =>
      bankingApi.recordInvoicePayment(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
      qc.invalidateQueries({ queryKey: accountingKeys.payments.all });
      qc.invalidateQueries({ queryKey: bankingKeys.deposits.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
      invalidateLedger(qc);
    },
  });
}

// ============================================================================
// Deposits
// ============================================================================

export function useUndepositedPayments(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: bankingKeys.deposits.undeposited(),
    queryFn: async () => (await bankingApi.listUndeposited()).data,
    enabled: options.enabled ?? true,
  });
}

export function useBankDeposits(filters?: DepositFilters) {
  return useQuery({
    queryKey: bankingKeys.deposits.list(filters),
    queryFn: () => bankingApi.listDeposits(filters),
  });
}

export function useBankDeposit(id: string | undefined) {
  return useQuery({
    queryKey: bankingKeys.deposits.detail(id ?? ''),
    queryFn: async () => (await bankingApi.getDeposit(id!)).data,
    enabled: !!id,
  });
}

export function useCreateBankDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateDepositInput) => bankingApi.createDeposit(data).then((res) => res.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bankingKeys.deposits.all });
      qc.invalidateQueries({ queryKey: accountingKeys.payments.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
      invalidateLedger(qc);
    },
  });
}

export function useUpdateBankDepositMemo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, memo }: { id: string; memo: string | null }) => bankingApi.updateDepositMemo(id, memo),
    onSuccess: () => qc.invalidateQueries({ queryKey: bankingKeys.deposits.all }),
  });
}

export function useVoidBankDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => bankingApi.voidDeposit(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bankingKeys.deposits.all });
      qc.invalidateQueries({ queryKey: accountingKeys.payments.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bankTransactions.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
      invalidateLedger(qc);
    },
  });
}

// ============================================================================
// Statement reconciliation
// ============================================================================

export function useBankReconciliations(filters?: ReconciliationHistoryFilters) {
  return useQuery({
    queryKey: bankingKeys.reconciliations.list(filters),
    queryFn: () => bankingApi.listReconciliations(filters),
  });
}

export function useBankReconciliation(id: string | undefined) {
  return useQuery({
    queryKey: bankingKeys.reconciliations.detail(id ?? ''),
    queryFn: async () => (await bankingApi.getReconciliation(id!)).data,
    enabled: !!id,
  });
}

export function useBankReconciliationReport(id: string | undefined) {
  return useQuery({
    queryKey: bankingKeys.reconciliations.report(id ?? ''),
    queryFn: async () => (await bankingApi.getReconciliationReport(id!)).data,
    enabled: !!id,
  });
}

export function useStartBankReconciliation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: StartReconciliationInput) => bankingApi.startReconciliation(data).then((res) => res.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: bankingKeys.reconciliations.all }),
  });
}

export function useSaveBankReconciliationProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: SaveReconciliationProgressInput }) =>
      bankingApi.saveReconciliationProgress(id, data).then((res) => res.data),
    onSuccess: (view) => {
      qc.setQueryData(bankingKeys.reconciliations.detail(view.id), view);
      qc.invalidateQueries({ queryKey: bankingKeys.reconciliations.report(view.id) });
      qc.invalidateQueries({ queryKey: [...bankingKeys.reconciliations.all, 'list'] });
    },
  });
}

export function useCompleteBankReconciliation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: CompleteReconciliationInput }) =>
      bankingApi.completeReconciliation(id, data).then((res) => res.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bankingKeys.reconciliations.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
      invalidateLedger(qc);
    },
  });
}

export function useUndoBankReconciliation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => bankingApi.undoReconciliation(id).then((res) => res.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bankingKeys.reconciliations.all });
      invalidateLedger(qc);
    },
  });
}

export function useDiscardBankReconciliation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => bankingApi.discardReconciliation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: bankingKeys.reconciliations.all }),
  });
}
