import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { accountingApi, type Invoice, type Bill, type Customer, type Account } from '@/lib/api/domains/weldbooks';

// ============================================================================
// Query Keys
// ============================================================================

export const accountingKeys = {
  all: ['accounting'] as const,
  dashboard: () => [...accountingKeys.all, 'dashboard'] as const,
  settings: () => [...accountingKeys.all, 'settings'] as const,

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
    profitLoss: (params?: Record<string, unknown>) => ['accounting', 'reports', 'profit-loss', params] as const,
    balanceSheet: (params?: Record<string, unknown>) => ['accounting', 'reports', 'balance-sheet', params] as const,
    trialBalance: (params?: Record<string, unknown>) => ['accounting', 'reports', 'trial-balance', params] as const,
    agedReceivables: () => ['accounting', 'reports', 'aged-receivables'] as const,
    agedPayables: () => ['accounting', 'reports', 'aged-payables'] as const,
    cashFlow: (params?: Record<string, unknown>) => ['accounting', 'reports', 'cash-flow', params] as const,
    generalLedger: (params?: Record<string, unknown>) => ['accounting', 'reports', 'general-ledger', params] as const,
  },
};

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

function useUpdateAccountingSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => accountingApi.updateSettings(data as any),
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.settings() }); },
  });
}

// ============================================================================
// Accounts
// ============================================================================

export function useAccountingAccounts(filters?: { type?: string; search?: string }) {
  return useQuery({
    queryKey: accountingKeys.accounts.list(filters),
    queryFn: () => accountingApi.listAccounts(filters),
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.accounts.all }); },
  });
}

function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => accountingApi.deleteAccount(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.accounts.all }); },
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

function useImportCrmCustomers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => accountingApi.importFromCrm(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.customers.all }); },
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.invoices.all }); },
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
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => accountingApi.recordInvoicePayment(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
      qc.invalidateQueries({ queryKey: accountingKeys.payments.all });
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: accountingKeys.bills.all }); },
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

function useUnreconciledTransactions() {
  return useQuery({
    queryKey: accountingKeys.bankTransactions.unreconciled(),
    queryFn: () => accountingApi.getUnreconciledTransactions(),
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
      accountingApi.createReconciliationRule(data as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.reconciliationRules.all });
    },
  });
}

export function useUpdateReconciliationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      accountingApi.updateReconciliationRule(id, data as any),
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
}

// ============================================================================
// Documents
// ============================================================================

function useAccountingDocuments(filters?: { status?: string; type?: string }) {
  return useQuery({
    queryKey: accountingKeys.documents.list(filters),
    queryFn: () => accountingApi.listDocuments(filters),
  });
}

function useDocumentStats() {
  return useQuery({
    queryKey: accountingKeys.documents.stats(),
    queryFn: () => accountingApi.getDocumentStats(),
  });
}

// ============================================================================
// Recurring Invoices
// ============================================================================

export function useAccountingRecurringInvoices() {
  return useQuery({
    queryKey: accountingKeys.recurring.list(),
    queryFn: () => accountingApi.listRecurringInvoices(),
  });
}

// ============================================================================
// Payments
// ============================================================================

function useAccountingPayments(filters?: { type?: string; page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: accountingKeys.payments.list(filters),
    queryFn: () => accountingApi.listPayments(filters),
  });
}

// ============================================================================
// Reports
// ============================================================================

export function useProfitLossReport(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: accountingKeys.reports.profitLoss(params),
    queryFn: () => accountingApi.getProfitLoss(params),
    enabled: false, // Only fetch on demand
  });
}

export function useBalanceSheetReport(params?: { asOf?: string }) {
  return useQuery({
    queryKey: accountingKeys.reports.balanceSheet(params),
    queryFn: () => accountingApi.getBalanceSheet(params),
    enabled: false,
  });
}

export function useTrialBalanceReport(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: accountingKeys.reports.trialBalance(params),
    queryFn: () => accountingApi.getTrialBalance(params),
    enabled: false,
  });
}

export function useAgedReceivablesReport() {
  return useQuery({
    queryKey: accountingKeys.reports.agedReceivables(),
    queryFn: () => accountingApi.getAgedReceivables(),
  });
}

export function useAgedPayablesReport() {
  return useQuery({
    queryKey: accountingKeys.reports.agedPayables(),
    queryFn: () => accountingApi.getAgedPayables(),
  });
}

function useCashFlowReport(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: accountingKeys.reports.cashFlow(params),
    queryFn: () => accountingApi.getCashFlow(params),
    enabled: false,
  });
}

function useGeneralLedgerReport(params?: { accountId?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: accountingKeys.reports.generalLedger(params),
    queryFn: () => accountingApi.getGeneralLedger(params as { accountId: string; from?: string; to?: string; page?: number; pageSize?: number }),
    enabled: false,
  });
}
