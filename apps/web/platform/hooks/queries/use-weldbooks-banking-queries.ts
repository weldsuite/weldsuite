import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  bankingApi,
  type BankAccountType,
  type BankLine,
  type BankLineFilters,
  type CompleteReconciliationInput,
  type CreateDepositInput,
  type DepositFilters,
  type ImportPreviewInput,
  type ImportStatementInput,
  type LinesForDocumentQuery,
  type MatchDocumentsInput,
  type ReconciliationHistoryFilters,
  type RecordBillPaymentInput,
  type RecordInvoicePaymentWithTarget,
  type SaveBankAccountInput,
  type SaveReconciliationProgressInput,
  type StartReconciliationInput,
} from '@/lib/api/domains/weldbooks-banking';
import { accountingApi } from '@/lib/api/domains/weldbooks';
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
    detail: (id: string) => [...accountingKeys.bankTransactions.all, 'detail', id] as const,
    links: (id: string) => [...accountingKeys.bankTransactions.all, 'links', id] as const,
    suggestions: (id: string) => [...accountingKeys.bankTransactions.all, 'suggestions', id] as const,
    openDocuments: (id: string, search: string) =>
      [...accountingKeys.bankTransactions.all, 'open-documents', id, search] as const,
    forDocument: (query: LinesForDocumentQuery | null) =>
      [...accountingKeys.bankTransactions.all, 'for-document', query] as const,
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

/** Lines and balances change; the ledger doesn't (only unbooked lines are removed). */
function invalidateAfterLineRemoval(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: accountingKeys.bankTransactions.all });
  qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
}

export function useUndoBankImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => bankingApi.undoImport(batchId).then((res) => res.data),
    onSuccess: () => invalidateAfterLineRemoval(qc),
  });
}

export function useDeleteBankLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => bankingApi.deleteBankLine(id),
    onSuccess: () => invalidateAfterLineRemoval(qc),
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

/** Lines a page of the infinite list asks for (the server allows up to 100). */
export const BANK_LINES_PAGE_SIZE = 50;

/**
 * Bank lines page by page, for lists that load more as you scroll or press "Load more".
 * `totalCount` is the server's real total, not what has loaded so far.
 */
export function useInfiniteBankLines(filters: Omit<BankLineFilters, 'page' | 'pageSize'> | undefined) {
  return useInfiniteQuery({
    queryKey: [...bankingKeys.lines.all, 'infinite', filters] as const,
    queryFn: ({ pageParam }) =>
      bankingApi.listBankLines({ ...filters, page: pageParam, pageSize: BANK_LINES_PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => (last.pagination?.hasMore ? pages.length + 1 : undefined),
    enabled: !!filters,
    select: (data) => {
      // A line that moved between pages while loading would show twice.
      const byId = new Map<string, BankLine>();
      for (const page of data.pages) for (const line of page.data) if (!byId.has(line.id)) byId.set(line.id, line);
      const lines = [...byId.values()];
      const totalCount = data.pages.at(-1)?.pagination?.totalCount ?? lines.length;
      return { lines, totalCount };
    },
  });
}

/** One bank line. The Global fallback of `useBankLineLinks`, which needs the Rust-only route. */
export function useBankLine(id: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: bankingKeys.lines.detail(id ?? ''),
    queryFn: async () => (await bankingApi.getBankLine(id!)).data,
    enabled: !!id && (options.enabled ?? true),
  });
}

/** A bank line with everything it is connected to. Only where the edition offers `books-bank-links`. */
export function useBankLineLinks(id: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: bankingKeys.lines.links(id ?? ''),
    queryFn: async () => (await bankingApi.getBankLineLinks(id!)).data,
    enabled: !!id && (options.enabled ?? true),
  });
}

/** Ignore a bank line. */
export function useExcludeBankLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lineId: string) => bankingApi.excludeBankLine(lineId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: accountingKeys.bankTransactions.all });
      void qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
    },
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
// Matching lines and documents either way round (edition feature `books-bank-links`)
// ============================================================================

/** A match settles documents too: their balances, statuses and payments change. */
function invalidateAfterDocumentMatch(qc: QueryClient) {
  invalidateAfterMatch(qc);
  void qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.bills.all });
}

/** The open documents an unmatched line could settle, best fit first. */
export function useOpenDocumentsForLine(lineId: string | null, search: string) {
  return useQuery({
    queryKey: bankingKeys.lines.openDocuments(lineId ?? '', search),
    queryFn: async () => (await bankingApi.openDocuments(lineId!, search)).data,
    enabled: !!lineId,
    placeholderData: keepPreviousData,
  });
}

/** The unmatched lines that could have paid a document, best fit first. */
export function useBankLinesForDocument(query: LinesForDocumentQuery | null) {
  return useQuery({
    queryKey: bankingKeys.lines.forDocument(query),
    queryFn: async () => (await bankingApi.linesForDocument(query!)).data,
    enabled: !!query,
    placeholderData: keepPreviousData,
  });
}

export function useMatchBankLineToDocuments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, data }: { lineId: string; data: MatchDocumentsInput }) =>
      bankingApi.matchDocuments(lineId, data),
    onSuccess: () => invalidateAfterDocumentMatch(qc),
  });
}

/** Undo a line's match (a payment the match made is voided, so its documents open again). */
export function useUnreconcileBankLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lineId: string) => bankingApi.unreconcileLine(lineId),
    onSuccess: () => invalidateAfterDocumentMatch(qc),
  });
}

/** Delete (void) a payment that no bank line confirms. */
export function useVoidPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: string) => accountingApi.deletePayment(paymentId),
    onSuccess: () => invalidateAfterDocumentMatch(qc),
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

/** Pay a bill out of a bank account (the default bank ledger account when none is named). */
export function useRecordBillPaymentWithTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: RecordBillPaymentInput }) => bankingApi.recordBillPayment(id, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: accountingKeys.bills.all });
      void qc.invalidateQueries({ queryKey: accountingKeys.payments.all });
      void qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
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
