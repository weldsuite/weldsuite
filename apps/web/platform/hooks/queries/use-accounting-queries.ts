import {
  keepPreviousData,
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import {
  accountingApi,
  type ApplyTaxLinesInput,
  type CreateAccountingEntityInput,
  type CreateDimensionValueInput,
  type CreateLockExceptionInput,
  type CreatePaymentInput,
  type DimensionValueFilters,
  type RecordInvoicePaymentInput,
  type ReconciliationRule,
  type UpdateAccountingEntityInput,
  type UpdateDimensionValueInput,
  type UpdateLockDatesInput,
} from '@/lib/api/domains/weldbooks';
import type {
  AgedReport,
  BalanceSheetReport,
  CashFlowReport,
  GeneralLedgerReport,
  ProfitLossReport,
  ReportName,
  ReportQuery,
  TaxWorksheet,
  TrialBalanceReport,
} from '@/lib/weldbooks/report-types';

// ============================================================================
// Query Keys
// ============================================================================

export const accountingKeys = {
  all: ['accounting'] as const,
  dashboard: () => [...accountingKeys.all, 'dashboard'] as const,
  settings: () => [...accountingKeys.all, 'settings'] as const,
  jurisdictions: () => [...accountingKeys.all, 'jurisdictions'] as const,

  /**
   * Entity rows. Not entity-scoped data: the list is the same whichever entity
   * is selected, and a detail is keyed by its own id.
   */
  entities: {
    all: [...(['accounting', 'entities'] as const)],
    detail: (id: string) => [...accountingKeys.entities.all, 'detail', id] as const,
    lockExceptions: (id: string) => [...accountingKeys.entities.all, 'lock-exceptions', id] as const,
  },

  /** The lines of the entity's income-tax return (US), per tax year. */
  taxLines: {
    all: [...(['accounting', 'tax-lines'] as const)],
    catalog: (year?: number) => [...accountingKeys.taxLines.all, year ?? 'current'] as const,
  },

  /** Classes and locations. */
  dimensions: {
    all: [...(['accounting', 'dimensions'] as const)],
    list: (filters?: DimensionValueFilters) => [...accountingKeys.dimensions.all, 'list', filters ?? {}] as const,
  },

  accounts: {
    all: [...(['accounting', 'accounts'] as const)],
    lists: () => [...accountingKeys.accounts.all, 'list'] as const,
    list: (filters?: Record<string, unknown>) => [...accountingKeys.accounts.lists(), filters] as const,
    details: () => [...accountingKeys.accounts.all, 'detail'] as const,
    detail: (id: string) => [...accountingKeys.accounts.details(), id] as const,
  },

  taxRates: {
    all: [...(['accounting', 'tax-rates'] as const)],
    lists: () => [...accountingKeys.taxRates.all, 'list'] as const,
    list: (filters?: Record<string, unknown>) => [...accountingKeys.taxRates.lists(), filters] as const,
  },

  customers: {
    all: [...(['accounting', 'customers'] as const)],
    lists: () => [...accountingKeys.customers.all, 'list'] as const,
    list: (filters?: Record<string, unknown>) => [...accountingKeys.customers.lists(), filters] as const,
    details: () => [...accountingKeys.customers.all, 'detail'] as const,
    detail: (id: string) => [...accountingKeys.customers.details(), id] as const,
  },

  invoices: {
    all: [...(['accounting', 'invoices'] as const)],
    lists: () => [...accountingKeys.invoices.all, 'list'] as const,
    list: (filters?: Record<string, unknown>) => [...accountingKeys.invoices.lists(), filters] as const,
    details: () => [...accountingKeys.invoices.all, 'detail'] as const,
    detail: (id: string) => [...accountingKeys.invoices.details(), id] as const,
  },

  bills: {
    all: [...(['accounting', 'bills'] as const)],
    lists: () => [...accountingKeys.bills.all, 'list'] as const,
    list: (filters?: Record<string, unknown>) => [...accountingKeys.bills.lists(), filters] as const,
    details: () => [...accountingKeys.bills.all, 'detail'] as const,
    detail: (id: string) => [...accountingKeys.bills.details(), id] as const,
  },

  journalEntries: {
    all: [...(['accounting', 'journal-entries'] as const)],
    lists: () => [...accountingKeys.journalEntries.all, 'list'] as const,
    list: (filters?: Record<string, unknown>) => [...accountingKeys.journalEntries.lists(), filters] as const,
    detail: (id: string) => [...accountingKeys.journalEntries.all, 'detail', id] as const,
  },

  bankAccounts: {
    all: [...(['accounting', 'bank-accounts'] as const)],
    list: () => [...accountingKeys.bankAccounts.all, 'list'] as const,
    detail: (id: string) => [...accountingKeys.bankAccounts.all, 'detail', id] as const,
  },

  bankTransactions: {
    all: [...(['accounting', 'bank-transactions'] as const)],
    list: (filters?: Record<string, unknown>) => [...accountingKeys.bankTransactions.all, 'list', filters] as const,
    unreconciled: () => [...accountingKeys.bankTransactions.all, 'unreconciled'] as const,
  },

  reconciliationRules: {
    all: [...(['accounting', 'reconciliation-rules'] as const)],
    list: () => [...accountingKeys.reconciliationRules.all, 'list'] as const,
  },

  vatReturns: {
    all: [...(['accounting', 'vat-returns'] as const)],
    list: () => [...accountingKeys.vatReturns.all, 'list'] as const,
    detail: (id: string) => [...accountingKeys.vatReturns.all, 'detail', id] as const,
  },

  documents: {
    all: [...(['accounting', 'documents'] as const)],
    list: (filters?: Record<string, unknown>) => [...accountingKeys.documents.all, 'list', filters] as const,
    stats: () => [...accountingKeys.documents.all, 'stats'] as const,
  },

  recurring: {
    all: [...(['accounting', 'recurring'] as const)],
    list: () => [...accountingKeys.recurring.all, 'list'] as const,
  },

  payments: {
    all: [...(['accounting', 'payments'] as const)],
    list: (filters?: Record<string, unknown>) => [...accountingKeys.payments.all, 'list', filters] as const,
  },

  reports: {
    all: [...(['accounting', 'reports'] as const)],
    report: (name: ReportName, query?: ReportQuery) => [...accountingKeys.reports.all, name, query ?? {}] as const,
  },
};

/**
 * True for an accounting query whose result depends on the selected entity
 * (the `X-Accounting-Entity-Id` header): everything under `['accounting']`
 * except the entity rows and the jurisdiction list.
 */
export function isEntityScopedAccountingQuery(queryKey: QueryKey): boolean {
  return queryKey[0] === 'accounting' && queryKey[1] !== 'entities' && queryKey[1] !== 'jurisdictions';
}

/**
 * Drop every entity-scoped accounting result after the selected entity
 * changed, so the previous entity's data is never shown under the new one.
 * Active queries refetch (with the new header); the rest refetch when used.
 */
export function resetEntityScopedAccountingQueries(qc: QueryClient) {
  return qc.resetQueries({ predicate: (query) => isEntityScopedAccountingQuery(query.queryKey) });
}

// ============================================================================
// Dashboard
// ============================================================================

export function useAccountingDashboard() {
  return useQuery({
    queryKey: accountingKeys.dashboard(),
    queryFn: () => accountingApi.getDashboard(),
  });
}

// ============================================================================
// Settings
// ============================================================================

export function useAccountingSettings() {
  return useQuery({
    queryKey: accountingKeys.settings(),
    queryFn: () => accountingApi.getSettings(),
  });
}

/** Dry run (`true`) counts what would be posted; `false` posts it. */
export function usePostingCatchUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dryRun: boolean) => accountingApi.postingCatchUp(dryRun),
    onSuccess: (_res, dryRun) => {
      if (dryRun) return;
      qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
      qc.invalidateQueries({ queryKey: accountingKeys.accounts.all });
      qc.invalidateQueries({ queryKey: accountingKeys.vatReturns.all });
      qc.invalidateQueries({ queryKey: ['accounting', 'reports'] });
      qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
    },
  });
}

// ============================================================================
// Entities + jurisdictions
// ============================================================================

export function useAccountingJurisdictions(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: accountingKeys.jurisdictions(),
    queryFn: async () => (await accountingApi.listJurisdictions()).data ?? [],
    enabled: options.enabled ?? true,
    staleTime: 60 * 60 * 1000,
  });
}

export function useAccountingEntity(id: string | null | undefined) {
  return useQuery({
    queryKey: accountingKeys.entities.detail(id ?? ''),
    queryFn: async () => (await accountingApi.getEntity(id!)).data,
    enabled: !!id,
  });
}

export function useCreateAccountingEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateAccountingEntityInput) => accountingApi.createEntity(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.entities.all });
    },
  });
}

export function useUpdateAccountingEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateAccountingEntityInput }) =>
      accountingApi.updateEntity(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.entities.all });
      // The accounting method and the fiscal year set the defaults of every report.
      qc.invalidateQueries({ queryKey: accountingKeys.reports.all });
    },
  });
}

/** US: remap every account to the lines of the entity's current return. */
export function useApplyTaxLines() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ entityId, data }: { entityId: string; data?: ApplyTaxLinesInput }) =>
      accountingApi.applyTaxLines(entityId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.accounts.all });
      qc.invalidateQueries({ queryKey: accountingKeys.taxLines.all });
      qc.invalidateQueries({ queryKey: accountingKeys.reports.all });
    },
  });
}

export function useUpdateLockDates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateLockDatesInput }) =>
      accountingApi.updateLockDates(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.entities.all });
    },
  });
}

export function useLockExceptions(entityId: string | null | undefined) {
  return useQuery({
    queryKey: accountingKeys.entities.lockExceptions(entityId ?? ''),
    queryFn: async () => (await accountingApi.listLockExceptions(entityId!)).data ?? [],
    enabled: !!entityId,
  });
}

export function useCreateLockException() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ entityId, data }: { entityId: string; data: CreateLockExceptionInput }) =>
      accountingApi.createLockException(entityId, data),
    onSuccess: (_res, { entityId }) => {
      qc.invalidateQueries({ queryKey: accountingKeys.entities.lockExceptions(entityId) });
    },
  });
}

export function useRevokeLockException() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ entityId, exceptionId }: { entityId: string; exceptionId: string }) =>
      accountingApi.revokeLockException(entityId, exceptionId),
    onSuccess: (_res, { entityId }) => {
      qc.invalidateQueries({ queryKey: accountingKeys.entities.lockExceptions(entityId) });
    },
  });
}
// ============================================================================
// Accounts
// ============================================================================

export function useAccountingAccounts(
  filters?: { type?: string; search?: string; taxLine?: string },
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: accountingKeys.accounts.list(filters),
    queryFn: () => accountingApi.listAccounts(filters),
    enabled: options.enabled ?? true,
  });
}

/** US: the lines of the entity's income-tax return for a tax year (default: the current one). */
export function useTaxLineCatalog(year?: number, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: accountingKeys.taxLines.catalog(year),
    queryFn: async () => (await accountingApi.getTaxLines(year)).data,
    enabled: options.enabled ?? true,
    staleTime: 10 * 60 * 1000,
  });
}

export function useAccountingAccount(id: string) {
  return useQuery({
    queryKey: accountingKeys.accounts.detail(id),
    queryFn: () => accountingApi.getAccount(id),
    enabled: !!id,
  });
}

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => accountingApi.createAccount(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.accounts.all }); },
  });
}

export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => accountingApi.updateAccount(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.accounts.all });
      // A tax line change moves the account between worksheet lines.
      qc.invalidateQueries({ queryKey: accountingKeys.reports.all });
    },
  });
}

// ============================================================================
// Dimensions (classes and locations)
// ============================================================================

export function useDimensionValues(filters?: DimensionValueFilters, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: accountingKeys.dimensions.list(filters),
    queryFn: async () => (await accountingApi.listDimensionValues(filters)).data ?? [],
    enabled: options.enabled ?? true,
  });
}

export function useCreateDimensionValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateDimensionValueInput) => accountingApi.createDimensionValue(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.dimensions.all }); },
  });
}

export function useUpdateDimensionValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateDimensionValueInput }) =>
      accountingApi.updateDimensionValue(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.dimensions.all }); },
  });
}

export function useDeleteDimensionValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => accountingApi.deleteDimensionValue(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.dimensions.all }); },
  });
}
// ============================================================================
// Tax Rates
// ============================================================================

export function useAccountingTaxRates(filters?: { type?: string }) {
  return useQuery({
    queryKey: accountingKeys.taxRates.list(filters),
    queryFn: () => accountingApi.listTaxRates(filters),
  });
}

// ============================================================================
// Customers
// ============================================================================

export function useAccountingCustomers(filters?: {
  role?: 'customer' | 'supplier' | 'both' | 'none';
  search?: string;
  page?: number;
  pageSize?: number;
}) {
  return useQuery({
    queryKey: accountingKeys.customers.list(filters),
    queryFn: () => accountingApi.listCustomers(filters),
  });
}

export function useAccountingCustomer(id: string) {
  return useQuery({
    queryKey: accountingKeys.customers.detail(id),
    queryFn: () => accountingApi.getCustomer(id),
    enabled: !!id,
  });
}

export function useCreateAccountingCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => accountingApi.createCustomer(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.customers.all }); },
  });
}

export function useUpdateAccountingCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => accountingApi.updateCustomer(id, data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: accountingKeys.customers.all });
      qc.invalidateQueries({ queryKey: accountingKeys.customers.detail(vars.id) });
    },
  });
}
// ============================================================================
// Invoices
// ============================================================================

export function useAccountingInvoices(filters?: { status?: string; type?: string; search?: string; page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: accountingKeys.invoices.list(filters),
    queryFn: () => accountingApi.listInvoices(filters),
  });
}

export function useAccountingInvoice(id: string) {
  return useQuery({
    queryKey: accountingKeys.invoices.detail(id),
    queryFn: () => accountingApi.getInvoice(id),
    enabled: !!id,
  });
}

export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => accountingApi.createInvoice(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.invoices.all }); },
  });
}

export function useUpdateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => accountingApi.updateInvoice(id, data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
      qc.invalidateQueries({ queryKey: accountingKeys.invoices.detail(vars.id) });
    },
  });
}

export function useSendInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => accountingApi.sendInvoice(id),
    onSuccess: () => {
      // Sending a draft finalizes (posts) it first.
      qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
      qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
      qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
    },
  });
}

/** `cancelled` (never-finalized invoices only) or `uncollectible` (bad-debt write-off). */
export function useUpdateInvoiceStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'cancelled' | 'uncollectible' }) =>
      accountingApi.updateInvoiceStatus(id, status),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
      qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
      qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
    },
  });
}

export function useFinalizeInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => accountingApi.finalizeInvoice(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
      qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
    },
  });
}

export function useRecordInvoicePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: RecordInvoicePaymentInput }) =>
      accountingApi.recordInvoicePayment(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
      qc.invalidateQueries({ queryKey: accountingKeys.payments.all });
      qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
      qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
    },
  });
}

/** A payment, optionally allocated over several invoices or bills. */
export function useCreatePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreatePaymentInput) => accountingApi.createPayment(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.payments.all });
      qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bills.all });
      qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
      qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
    },
  });
}

// ============================================================================
// Bills
// ============================================================================

export function useAccountingBills(filters?: { status?: string; search?: string; page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: accountingKeys.bills.list(filters),
    queryFn: () => accountingApi.listBills(filters),
  });
}

export function useAccountingBill(id: string) {
  return useQuery({
    queryKey: accountingKeys.bills.detail(id),
    queryFn: () => accountingApi.getBill(id),
    enabled: !!id,
  });
}

export function useCreateBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => accountingApi.createBill(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.bills.all }); },
  });
}

export function useUpdateBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => accountingApi.updateBill(id, data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: accountingKeys.bills.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bills.detail(vars.id) });
    },
  });
}

export function useApproveBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => accountingApi.approveBill(id),
    onSuccess: () => {
      // Approving a bill posts it to the ledger.
      qc.invalidateQueries({ queryKey: accountingKeys.bills.all });
      qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
    },
  });
}

export function useRejectBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => accountingApi.rejectBill(id, reason),
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.bills.all }); },
  });
}

// ============================================================================
// Journal Entries
// ============================================================================

export function useAccountingJournalEntries(filters?: { status?: string; page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: accountingKeys.journalEntries.list(filters),
    queryFn: () => accountingApi.listJournalEntries(filters),
  });
}

export function useAccountingJournalEntry(id: string) {
  return useQuery({
    queryKey: accountingKeys.journalEntries.detail(id),
    queryFn: () => accountingApi.getJournalEntry(id),
    enabled: !!id,
  });
}

export function useCreateJournalEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => accountingApi.createJournalEntry(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all }); },
  });
}

export function usePostJournalEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => accountingApi.postJournalEntry(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
      qc.invalidateQueries({ queryKey: accountingKeys.accounts.all });
    },
  });
}

// ============================================================================
// Bank Accounts
// ============================================================================

export function useAccountingBankAccounts() {
  return useQuery({
    queryKey: accountingKeys.bankAccounts.list(),
    queryFn: () => accountingApi.listBankAccounts(),
  });
}

export function useAccountingBankAccount(id: string | undefined) {
  return useQuery({
    queryKey: accountingKeys.bankAccounts.detail(id ?? ''),
    queryFn: () => accountingApi.getBankAccount(id!),
    enabled: !!id,
  });
}

export function useCreateBankAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => accountingApi.createBankAccount(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
      qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
    },
  });
}

export function useUpdateBankAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      accountingApi.updateBankAccount(id, data),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.detail(id) });
    },
  });
}

export function useDeleteBankAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => accountingApi.deleteBankAccount(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
    },
  });
}

// ============================================================================
// Bank Transactions
// ============================================================================

export function useAccountingBankTransactions(filters?: { bankAccountId?: string; status?: string; from?: string; to?: string; search?: string; page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: accountingKeys.bankTransactions.list(filters),
    queryFn: () => accountingApi.listBankTransactions(filters),
  });
}

export function useCreateBankTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      bankAccountId: string;
      date: string;
      amount: string | number;
      description?: string;
      valueDate?: string;
      counterpartyName?: string;
      counterpartyIban?: string;
      counterpartyBic?: string;
      reference?: string;
      notes?: string;
      categoryAccountId?: string;
    }) => accountingApi.createBankTransaction(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.bankTransactions.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
      qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
      qc.invalidateQueries({ queryKey: accountingKeys.accounts.all });
      qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
    },
  });
}

export function useAutoReconcile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bankAccountId: string) => accountingApi.autoReconcile(bankAccountId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.bankTransactions.all });
      qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
    },
  });
}

// ============================================================================
// Reconciliation Rules
// ============================================================================

export function useReconciliationRules() {
  return useQuery({
    queryKey: accountingKeys.reconciliationRules.list(),
    queryFn: () => accountingApi.listReconciliationRules(),
  });
}

export function useCreateReconciliationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      accountingApi.createReconciliationRule(data as unknown as Partial<ReconciliationRule>),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.reconciliationRules.all });
    },
  });
}

export function useUpdateReconciliationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      accountingApi.updateReconciliationRule(id, data as unknown as Partial<ReconciliationRule>),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.reconciliationRules.all });
    },
  });
}

export function useDeleteReconciliationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => accountingApi.deleteReconciliationRule(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.reconciliationRules.all });
    },
  });
}

// ============================================================================
// VAT Returns
// ============================================================================

export function useAccountingVatReturns() {
  return useQuery({
    queryKey: accountingKeys.vatReturns.list(),
    queryFn: () => accountingApi.listVatReturns(),
  });
}

export function useCalculateVatReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => accountingApi.calculateVatReturn(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.vatReturns.all }); },
  });
}// ============================================================================
// Recurring Invoices
// ============================================================================

export function useAccountingRecurringInvoices() {
  return useQuery({
    queryKey: accountingKeys.recurring.list(),
    queryFn: () => accountingApi.listRecurringInvoices(),
  });
}
// ============================================================================
// Reports
// ============================================================================

interface ReportOptions {
  enabled?: boolean;
}

/**
 * A financial report. Runs whenever its query changes; the previous result
 * stays on screen while the next one loads, so toggling the basis or the
 * comparison doesn't blank the table.
 */
function useReport<T>(name: ReportName, fetcher: () => Promise<{ data: T }>, query: ReportQuery, options: ReportOptions) {
  return useQuery({
    queryKey: accountingKeys.reports.report(name, query),
    queryFn: async () => (await fetcher()).data,
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
  });
}

export function useProfitLossReport(query: ReportQuery = {}, options: ReportOptions = {}) {
  return useReport<ProfitLossReport>('profit-loss', () => accountingApi.getProfitLoss(query), query, options);
}

export function useBalanceSheetReport(query: ReportQuery = {}, options: ReportOptions = {}) {
  return useReport<BalanceSheetReport>('balance-sheet', () => accountingApi.getBalanceSheet(query), query, options);
}

export function useTrialBalanceReport(query: ReportQuery = {}, options: ReportOptions = {}) {
  return useReport<TrialBalanceReport>('trial-balance', () => accountingApi.getTrialBalance(query), query, options);
}

export function useGeneralLedgerReport(query: ReportQuery & { accountId: string }, options: ReportOptions = {}) {
  return useReport<GeneralLedgerReport>(
    'general-ledger',
    () => accountingApi.getGeneralLedger(query),
    query,
    { enabled: (options.enabled ?? true) && !!query.accountId },
  );
}

export function useCashFlowReport(query: ReportQuery = {}, options: ReportOptions = {}) {
  return useReport<CashFlowReport>('cash-flow', () => accountingApi.getCashFlow(query), query, options);
}

export function useAgedReceivablesReport(query: ReportQuery = {}, options: ReportOptions = {}) {
  return useReport<AgedReport>('aged-receivables', () => accountingApi.getAgedReceivables(query), query, options);
}

export function useAgedPayablesReport(query: ReportQuery = {}, options: ReportOptions = {}) {
  return useReport<AgedReport>('aged-payables', () => accountingApi.getAgedPayables(query), query, options);
}

/** US only: the fiscal year's trial balance grouped by the lines of the entity's income-tax return. */
export function useTaxWorksheetReport(query: ReportQuery = {}, options: ReportOptions = {}) {
  return useReport<TaxWorksheet>('tax-worksheet', () => accountingApi.getTaxWorksheet(query), query, options);
}
