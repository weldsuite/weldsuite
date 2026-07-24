import { weldbooksApi } from '../weldbooks-client';

// ============================================================================
// Types
// ============================================================================

export interface Dashboard {
  revenue: { month: string; year: string; invoiceCount: number };
  expenses: { month: string; year: string };
  profit: { month: string; year: string };
  receivables: { outstanding: string; outstandingCount: number; overdue: string; overdueCount: number };
  payables: { outstanding: string; outstandingCount: number };
  bankAccounts: Array<{ id: string; name: string; iban: string | null; currentBalance: string | null; currency: string | null }>;
  recentPayments: Payment[];
  upcomingDue: Array<{ id: string; invoiceNumber: string | null; contactName: string | null; dueDate: string; balanceDue: string | null }>;
  pendingDocuments: number;
  monthlyRevenue: Array<{ month: string; total: string }>;
}

export interface Settings {
  id: string;
  fiscalYearStart: number | null;
  defaultCurrency: string | null;
  country: string | null;
  accountingMethod: string | null;
  defaultPaymentTermsDays: number | null;
  invoiceNumberPrefix: string | null;
  invoiceNumberNext: number | null;
  billNumberPrefix: string | null;
  billNumberNext: number | null;
  creditNoteNumberPrefix: string | null;
  creditNoteNumberNext: number | null;
  journalNumberPrefix: string | null;
  journalNumberNext: number | null;
  companyDetails: Record<string, unknown> | null;
  taxSettings: Record<string, unknown> | null;
  emailSettings: Record<string, unknown> | null;
  invoiceTemplateSettings: Record<string, unknown> | null;
  digipoortSettings: Record<string, unknown> | null;
}

export interface Account {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: string;
  subtype: string | null;
  parentAccountId: string | null;
  currency: string | null;
  isActive: boolean | null;
  isSystemAccount: boolean | null;
  openingBalance: string | null;
  currentBalance: string | null;
  normalSide: string;
}

export interface TaxRate {
  id: string;
  name: string;
  rate: string;
  type: string;
  isDefault: boolean | null;
  isActive: boolean | null;
  btwRubriek: string | null;
  description: string | null;
  ledgerAccountId: string | null;
  reverseCharge: boolean | null;
  euService: boolean | null;
  exportGoods: boolean | null;
}

export interface Customer {
  id: string;
  type: string;
  role: 'none' | 'customer' | 'supplier' | 'both' | string;
  name: string;
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  taxNumber: string | null;
  kvkNumber: string | null;
  iban: string | null;
  bic: string | null;
  paymentTermsDays: number | null;
  notes: string | null;
  outstandingBalance: string | null;
  createdAt: string;
}

export interface Invoice {
  id: string;
  invoiceNumber: string | null;
  type: string;
  status: string;
  contactId: string;
  contactName: string | null;
  contactEmail: string | null;
  issueDate: string;
  dueDate: string;
  currency: string | null;
  subtotal: string | null;
  taxTotal: string | null;
  total: string | null;
  amountPaid: string | null;
  balanceDue: string | null;
  reference: string | null;
  notes: string | null;
  internalNotes: string | null;
  createdAt: string;
}

export interface InvoiceDetail extends Invoice {
  items: InvoiceItem[];
  payments: Payment[];
}

interface InvoiceItem {
  id: string;
  invoiceId: string;
  description: string;
  quantity: string | null;
  unitPrice: string;
  unit: string | null;
  discountPercent: string | null;
  taxRateId: string | null;
  taxRate: string | null;
  taxAmount: string | null;
  lineTotal: string | null;
  lineTotalWithTax: string | null;
  accountId: string | null;
  sortOrder: number | null;
}

export interface Bill {
  id: string;
  billNumber: string | null;
  type: string;
  status: string;
  contactId: string;
  contactName: string | null;
  issueDate: string;
  dueDate: string;
  currency: string | null;
  subtotal: string | null;
  taxTotal: string | null;
  total: string | null;
  amountPaid: string | null;
  balanceDue: string | null;
  externalReference: string | null;
  approvalStatus: string | null;
  notes: string | null;
  internalNotes: string | null;
  createdAt: string;
}

export interface BillDetail extends Bill {
  items: BillItem[];
}

interface BillItem {
  id: string;
  billId: string;
  description: string;
  quantity: string | null;
  unitPrice: string;
  unit: string | null;
  discountPercent: string | null;
  taxRateId: string | null;
  taxRate: string | null;
  taxAmount: string | null;
  lineTotal: string | null;
  lineTotalWithTax: string | null;
  accountId: string | null;
  sortOrder: number | null;
}

export interface JournalEntry {
  id: string;
  entryNumber: string | null;
  date: string;
  status: string;
  description: string | null;
  totalDebit: string | null;
  totalCredit: string | null;
  sourceType: string | null;
  isAutomatic: boolean | null;
}

export interface JournalLine {
  id: string;
  journalEntryId: string;
  accountId: string;
  description: string | null;
  debit: string | null;
  credit: string | null;
  taxRateId: string | null;
  taxAmount: string | null;
  contactId: string | null;
  currency: string | null;
  reconciled: boolean | null;
  sortOrder: number | null;
}

export interface JournalEntryDetail extends JournalEntry {
  lines: JournalLine[];
}

export interface BankAccount {
  id: string;
  entityId?: string;
  name: string;
  iban: string | null;
  bic?: string | null;
  bankName: string | null;
  accountHolderName?: string | null;
  currentBalance: string | null;
  currency: string | null;
  ledgerAccountId?: string | null;
  isDefault?: boolean | null;
  isActive: boolean | null;
  autoReconcile?: boolean | null;
  lastImportDate?: string | null;
  lastImportBalance?: string | null;
}

export interface BankTransaction {
  id: string;
  bankAccountId: string;
  date: string;
  valueDate?: string | null;
  description: string | null;
  amount: string;
  runningBalance?: string | null;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  counterpartyBic?: string | null;
  reference: string | null;
  transactionCode?: string | null;
  endToEndId?: string | null;
  mandateId?: string | null;
  status: string;
  reconciliationType?: string | null;
  reconciledInvoiceId?: string | null;
  reconciledBillId?: string | null;
  categoryAccountId?: string | null;
  contactId?: string | null;
}

export interface ReconciliationRuleCondition {
  field: 'description' | 'counterpartyName' | 'counterpartyIban' | 'amount' | 'reference';
  operator: 'contains' | 'equals' | 'starts_with' | 'ends_with' | 'greater_than' | 'less_than' | 'between';
  value: string | number;
  value2?: number;
}

interface ReconciliationRuleActions {
  categoryAccountId?: string;
  taxRateId?: string;
  contactId?: string;
  description?: string;
}

export interface ReconciliationRule {
  id: string;
  entityId?: string;
  name: string;
  priority: number;
  isActive: boolean;
  matchMode: 'all' | 'any';
  conditions: ReconciliationRuleCondition[];
  actions: ReconciliationRuleActions;
  matchCount: number;
  lastMatchedAt?: string | null;
  createdBy?: string | null;
}

export interface VatReturn {
  id: string;
  periodType: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string | null;
  status: string;
  rubrieken: Record<string, number> | null;
  correctionOfId?: string | null;
  suppletieDeadline?: string | null;
  filingReference?: string | null;
  filedAt?: string | null;
  filedBy?: string | null;
  notes?: string | null;
}

export interface IcpDeclaration {
  id: string;
  periodType: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string | null;
  status: string;
  totalAmount: string;
  filingReference?: string | null;
  notes?: string | null;
}

interface IcpLine {
  id: string;
  contactId: string | null;
  vatNumber: string;
  countryCode: string;
  supplyType: 'goods' | 'services' | 'triangulation' | string;
  amount: string;
}

export interface IcpDeclarationDetail extends IcpDeclaration {
  lines: IcpLine[];
}

export interface Document {
  id: string;
  type: string;
  fileName: string;
  fileKey: string;
  source: string;
  status: string;
  ocrResult: Record<string, unknown> | null;
  matchedContactId: string | null;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  createdAt: string;
}

export interface Payment {
  id: string;
  type: string;
  amount: string;
  date: string;
  paymentMethod: string | null;
  reference: string | null;
  invoiceId: string | null;
  billId: string | null;
  contactId: string;
}

export interface RecurringInvoiceTemplateItem {
  description: string;
  quantity: number;
  unitPrice: number;
  unit?: string;
  taxRateId?: string;
  accountId?: string;
}

export interface RecurringInvoiceTemplateData {
  items?: RecurringInvoiceTemplateItem[];
  notes?: string;
  internalNotes?: string;
  paymentTermsDays?: number;
  revenueAccountId?: string;
  reference?: string;
}

export interface RecurringInvoice {
  id: string;
  name: string | null;
  contactId: string;
  frequency: string;
  dayOfMonth: number | null;
  nextIssueDate: string;
  endDate: string | null;
  status: string;
  templateData: RecurringInvoiceTemplateData | null;
  autoSend: boolean | null;
  autoFinalize: boolean | null;
  generatedCount: number | null;
  lastGeneratedAt: string | null;
  lastGeneratedInvoiceId: string | null;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: { page: number; pageSize: number; totalCount: number; totalPages: number; hasMore: boolean };
}

// ============================================================================
// API Methods
// ============================================================================

function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') qs.set(key, String(val));
  }
  const str = qs.toString();
  return str ? `?${str}` : '';
}

export const accountingApi = {
  // Dashboard
  getDashboard: () => weldbooksApi.get<ApiResponse<Dashboard>>('/accounting-dashboard'),

  // Settings
  getSettings: () => weldbooksApi.get<ApiResponse<Settings>>('/accounting-settings'),
  updateSettings: (data: Partial<Settings>) => weldbooksApi.patch<ApiResponse<Settings>>('/accounting-settings', data),
  seedWorkflows: () => weldbooksApi.post<ApiResponse<{ templatesCreated: number }>>('/accounting-settings/seed-workflows'),
  registerInbox: (email: string) => weldbooksApi.post<ApiResponse<{ email: string; accountId: string }>>('/accounting-settings/inbox', { email }),
  getExchangeRates: () =>
    weldbooksApi.get<
      ApiResponse<{
        rates: Record<string, number>;
        currencies: Array<{ code: string; name: string; symbol: string }>;
        baseCurrency: string;
      }>
    >('/accounting-settings/exchange-rates'),
  getExchangeRate: (from: string, to: string) =>
    weldbooksApi.get<ApiResponse<{ from: string; to: string; rate: number }>>(`/accounting-settings/exchange-rate/${from}/${to}`),

  // Accounts
  listAccounts: (params?: { type?: string; subtype?: string; isActive?: string; search?: string }) =>
    weldbooksApi.get<ApiResponse<Account[]>>(`/gl-accounts${buildQuery(params || {})}`),
  getAccount: (id: string) => weldbooksApi.get<ApiResponse<Account>>(`/gl-accounts/${id}`),
  createAccount: (data: Record<string, unknown>) => weldbooksApi.post<ApiResponse<Account>>('/gl-accounts', data),
  updateAccount: (id: string, data: Record<string, unknown>) => weldbooksApi.patch<ApiResponse<Account>>(`/gl-accounts/${id}`, data),
  deleteAccount: (id: string) => weldbooksApi.delete<ApiResponse<unknown>>(`/gl-accounts/${id}`),

  // Tax Rates
  listTaxRates: (params?: { type?: string; isActive?: string }) =>
    weldbooksApi.get<ApiResponse<TaxRate[]>>(`/tax-rates${buildQuery(params || {})}`),
  getTaxRate: (id: string) => weldbooksApi.get<ApiResponse<TaxRate>>(`/tax-rates/${id}`),
  createTaxRate: (data: Record<string, unknown>) => weldbooksApi.post<ApiResponse<TaxRate>>('/tax-rates', data),
  updateTaxRate: (id: string, data: Record<string, unknown>) => weldbooksApi.patch<ApiResponse<TaxRate>>(`/tax-rates/${id}`, data),
  deleteTaxRate: (id: string) => weldbooksApi.delete<ApiResponse<unknown>>(`/tax-rates/${id}`),

  // Contacts
  listCustomers: (params?: {
    role?: 'customer' | 'supplier' | 'both' | 'none';
    search?: string;
    page?: number;
    pageSize?: number;
  }) =>
    weldbooksApi.get<PaginatedResponse<Customer>>(`/accounting-contacts${buildQuery(params || {})}`),
  getCustomer: (id: string) => weldbooksApi.get<ApiResponse<Customer>>(`/accounting-contacts/${id}`),
  getCustomerBalance: (id: string) => weldbooksApi.get<ApiResponse<unknown>>(`/accounting-contacts/${id}/balance`),
  createCustomer: (data: Record<string, unknown>) => weldbooksApi.post<ApiResponse<Customer>>('/accounting-contacts', data),
  updateCustomer: (id: string, data: Record<string, unknown>) => weldbooksApi.patch<ApiResponse<Customer>>(`/accounting-contacts/${id}`, data),
  deleteCustomer: (id: string) => weldbooksApi.delete<ApiResponse<unknown>>(`/accounting-contacts/${id}`),
  importFromCrm: () => weldbooksApi.post<ApiResponse<{ imported: number }>>('/accounting-contacts/import-from-crm'),

  // Invoices
  listInvoices: (params?: { status?: string; type?: string; contactId?: string; from?: string; to?: string; overdue?: string; search?: string; page?: number; pageSize?: number }) =>
    weldbooksApi.get<PaginatedResponse<Invoice>>(`/invoices${buildQuery(params || {})}`),
  getInvoice: (id: string) => weldbooksApi.get<ApiResponse<InvoiceDetail>>(`/invoices/${id}`),
  getInvoicePdf: (id: string) => weldbooksApi.get<string>(`/invoices/${id}/pdf`),
  createInvoice: (data: Record<string, unknown>) => weldbooksApi.post<ApiResponse<InvoiceDetail>>('/invoices', data),
  updateInvoice: (id: string, data: Record<string, unknown>) => weldbooksApi.patch<ApiResponse<Invoice>>(`/invoices/${id}`, data),
  deleteInvoice: (id: string) => weldbooksApi.delete<ApiResponse<unknown>>(`/invoices/${id}`),
  sendInvoice: (id: string) => weldbooksApi.patch<ApiResponse<Invoice>>(`/invoices/${id}/send`),
  updateInvoiceStatus: (id: string, status: string) => weldbooksApi.patch<ApiResponse<Invoice>>(`/invoices/${id}/status`, { status }),
  finalizeInvoice: (id: string) => weldbooksApi.post<ApiResponse<{ invoiceId: string; journalEntryId: string }>>(`/invoices/${id}/finalize`),
  duplicateInvoice: (id: string) => weldbooksApi.post<ApiResponse<{ id: string }>>(`/invoices/${id}/duplicate`),
  createCreditNote: (id: string) => weldbooksApi.post<ApiResponse<{ id: string; invoiceNumber: string }>>(`/invoices/${id}/credit-note`),
  recordInvoicePayment: (id: string, data: Record<string, unknown>) => weldbooksApi.post<ApiResponse<unknown>>(`/invoices/${id}/record-payment`, data),
  createInvoiceFromOrder: (orderId: string) =>
    weldbooksApi.post<ApiResponse<{ invoiceId: string; invoiceNumber: string }>>(`/invoices/from-order/${orderId}`),

  // Bills
  listBills: (params?: { status?: string; contactId?: string; from?: string; to?: string; search?: string; page?: number; pageSize?: number }) =>
    weldbooksApi.get<PaginatedResponse<Bill>>(`/bills${buildQuery(params || {})}`),
  getBill: (id: string) => weldbooksApi.get<ApiResponse<BillDetail>>(`/bills/${id}`),
  createBill: (data: Record<string, unknown>) => weldbooksApi.post<ApiResponse<Bill>>('/bills', data),
  updateBill: (id: string, data: Record<string, unknown>) => weldbooksApi.patch<ApiResponse<Bill>>(`/bills/${id}`, data),
  deleteBill: (id: string) => weldbooksApi.delete<ApiResponse<unknown>>(`/bills/${id}`),
  getBillFromDocument: (docId: string) => weldbooksApi.post<ApiResponse<unknown>>(`/bills/from-document/${docId}`),
  approveBill: (id: string) => weldbooksApi.patch<ApiResponse<Bill>>(`/bills/${id}/approve`),
  rejectBill: (id: string, reason: string) => weldbooksApi.patch<ApiResponse<Bill>>(`/bills/${id}/reject`, { reason }),

  // Journal Entries
  listJournalEntries: (params?: { status?: string; sourceType?: string; from?: string; to?: string; page?: number; pageSize?: number }) =>
    weldbooksApi.get<PaginatedResponse<JournalEntry>>(`/journal-entries${buildQuery(params || {})}`),
  getJournalEntry: (id: string) => weldbooksApi.get<ApiResponse<JournalEntryDetail>>(`/journal-entries/${id}`),
  createJournalEntry: (data: Record<string, unknown>) => weldbooksApi.post<ApiResponse<JournalEntry>>('/journal-entries', data),
  postJournalEntry: (id: string) => weldbooksApi.post<ApiResponse<JournalEntry>>(`/journal-entries/${id}/post`),
  reverseJournalEntry: (id: string) => weldbooksApi.post<ApiResponse<{ id: string; entryNumber: string }>>(`/journal-entries/${id}/reverse`),

  // Bank Accounts
  listBankAccounts: () => weldbooksApi.get<ApiResponse<BankAccount[]>>('/bank-accounts'),
  getBankAccount: (id: string) => weldbooksApi.get<ApiResponse<BankAccount>>(`/bank-accounts/${id}`),
  createBankAccount: (data: Record<string, unknown>) => weldbooksApi.post<ApiResponse<BankAccount>>('/bank-accounts', data),
  updateBankAccount: (id: string, data: Record<string, unknown>) => weldbooksApi.patch<ApiResponse<BankAccount>>(`/bank-accounts/${id}`, data),
  deleteBankAccount: (id: string) => weldbooksApi.delete<ApiResponse<unknown>>(`/bank-accounts/${id}`),

  // Bank Transactions
  listBankTransactions: (params?: { bankAccountId?: string; status?: string; from?: string; to?: string; search?: string; page?: number; pageSize?: number }) =>
    weldbooksApi.get<PaginatedResponse<BankTransaction>>(`/bank-transactions${buildQuery(params || {})}`),
  getUnreconciledTransactions: () => weldbooksApi.get<ApiResponse<BankTransaction[]>>('/bank-transactions/unreconciled'),
  getTransactionSuggestions: (id: string) => weldbooksApi.get<ApiResponse<unknown[]>>(`/bank-transactions/${id}/suggestions`),
  reconcileTransaction: (id: string, data: Record<string, unknown>) => weldbooksApi.post<ApiResponse<unknown>>(`/bank-transactions/${id}/reconcile`, data),
  excludeTransaction: (id: string) => weldbooksApi.post<ApiResponse<unknown>>(`/bank-transactions/${id}/exclude`),
  importBankTransactions: (data: { bankAccountId: string; content: string; fileName: string; format?: string }) =>
    weldbooksApi.post<ApiResponse<{ batchId: string; format: string; totalParsed: number; imported: number; duplicates: number; autoReconciled: number; errors: Array<{ line?: number; message: string }> }>>('/bank-transactions/import', data),
  autoReconcile: (bankAccountId: string) =>
    weldbooksApi.post<ApiResponse<{ reconciledCount: number }>>('/bank-transactions/auto-reconcile', { bankAccountId }),

  // Reconciliation Rules
  listReconciliationRules: () =>
    weldbooksApi.get<ApiResponse<ReconciliationRule[]>>('/reconciliation-rules'),
  createReconciliationRule: (data: Partial<ReconciliationRule>) =>
    weldbooksApi.post<ApiResponse<ReconciliationRule>>('/reconciliation-rules', data),
  updateReconciliationRule: (id: string, data: Partial<ReconciliationRule>) =>
    weldbooksApi.patch<ApiResponse<ReconciliationRule>>(`/reconciliation-rules/${id}`, data),
  deleteReconciliationRule: (id: string) =>
    weldbooksApi.delete<ApiResponse<unknown>>(`/reconciliation-rules/${id}`),

  // VAT Returns
  listVatReturns: () => weldbooksApi.get<ApiResponse<VatReturn[]>>('/vat-returns'),
  getVatReturn: (id: string) => weldbooksApi.get<ApiResponse<VatReturn>>(`/vat-returns/${id}`),
  calculateVatReturn: (data: Record<string, unknown>) => weldbooksApi.post<ApiResponse<{ id: string; rubrieken: Record<string, number> }>>('/vat-returns/calculate', data),
  updateVatReturn: (id: string, data: Record<string, unknown>) => weldbooksApi.patch<ApiResponse<VatReturn>>(`/vat-returns/${id}`, data),
  fileVatReturn: (id: string) => weldbooksApi.post<ApiResponse<unknown>>(`/vat-returns/${id}/file`),
  getVatReturnXml: (id: string) => weldbooksApi.get<string>(`/vat-returns/${id}/xml`),
  getVatFilingStatus: (id: string) =>
    weldbooksApi.get<ApiResponse<{ id: string; kenmerk: string; status: string; statusDescription?: string; simulated?: boolean }>>(`/vat-returns/${id}/filing-status`),
  createSuppletie: (id: string) =>
    weldbooksApi.post<ApiResponse<{ correctionRequired: boolean; id?: string; netDiff: number; foldIntoNextReturn?: boolean; suppletieDeadline?: string; message: string }>>(`/vat-returns/${id}/suppletie`),

  // ICP declarations (Opgaaf ICP)
  listIcpDeclarations: () => weldbooksApi.get<ApiResponse<IcpDeclaration[]>>('/icp-declarations'),
  getIcpDeclaration: (id: string) => weldbooksApi.get<ApiResponse<IcpDeclarationDetail>>(`/icp-declarations/${id}`),
  calculateIcpDeclaration: (data: Record<string, unknown>) =>
    weldbooksApi.post<ApiResponse<{ id: string; totalAmount: number; lineCount: number; skippedContacts: string[] }>>('/icp-declarations/calculate', data),
  fileIcpDeclaration: (id: string) => weldbooksApi.post<ApiResponse<unknown>>(`/icp-declarations/${id}/file`),
  getIcpDeclarationXml: (id: string) => weldbooksApi.get<string>(`/icp-declarations/${id}/xml`),

  // Exports
  getXafAuditfile: (fiscalYear: number) => weldbooksApi.get<string>(`/accounting-exports/xaf?fiscalYear=${fiscalYear}`),

  // Documents
  listDocuments: (params?: { status?: string; type?: string; source?: string }) =>
    weldbooksApi.get<ApiResponse<Document[]>>(`/accounting-documents${buildQuery(params || {})}`),
  getDocument: (id: string) => weldbooksApi.get<ApiResponse<Document>>(`/accounting-documents/${id}`),
  createDocument: (data: Record<string, unknown>) => weldbooksApi.post<ApiResponse<Document>>('/accounting-documents', data),
  processDocument: (id: string) => weldbooksApi.post<ApiResponse<unknown>>(`/accounting-documents/${id}/process`),
  rematchDocument: (id: string) => weldbooksApi.post<ApiResponse<{ id: string; matchedContactId: string | null }>>(`/accounting-documents/${id}/rematch`),
  linkDocument: (id: string, data: { linkedEntityType: string; linkedEntityId: string }) => weldbooksApi.patch<ApiResponse<unknown>>(`/accounting-documents/${id}/link`, data),
  rejectDocument: (id: string) => weldbooksApi.patch<ApiResponse<unknown>>(`/accounting-documents/${id}/reject`),
  getDocumentStats: () => weldbooksApi.get<ApiResponse<Array<{ status: string; count: number }>>>('/accounting-documents/stats'),

  // Recurring Invoices
  listRecurringInvoices: () => weldbooksApi.get<ApiResponse<RecurringInvoice[]>>('/recurring-invoices'),
  getRecurringInvoice: (id: string) => weldbooksApi.get<ApiResponse<RecurringInvoice>>(`/recurring-invoices/${id}`),
  createRecurringInvoice: (data: Record<string, unknown>) => weldbooksApi.post<ApiResponse<RecurringInvoice>>('/recurring-invoices', data),
  updateRecurringInvoice: (id: string, data: Record<string, unknown>) => weldbooksApi.patch<ApiResponse<RecurringInvoice>>(`/recurring-invoices/${id}`, data),
  deleteRecurringInvoice: (id: string) => weldbooksApi.delete<ApiResponse<unknown>>(`/recurring-invoices/${id}`),
  pauseRecurringInvoice: (id: string) => weldbooksApi.patch<ApiResponse<unknown>>(`/recurring-invoices/${id}/pause`),
  resumeRecurringInvoice: (id: string) => weldbooksApi.patch<ApiResponse<unknown>>(`/recurring-invoices/${id}/resume`),
  generateRecurringInvoice: (id: string) => weldbooksApi.post<ApiResponse<{ invoiceId: string; invoiceNumber: string; nextIssueDate: string }>>(`/recurring-invoices/${id}/generate`),

  // Payments
  listPayments: (params?: { type?: string; contactId?: string; from?: string; to?: string; page?: number; pageSize?: number }) =>
    weldbooksApi.get<PaginatedResponse<Payment>>(`/payments${buildQuery(params || {})}`),
  getPayment: (id: string) => weldbooksApi.get<ApiResponse<Payment>>(`/payments/${id}`),
  createPayment: (data: Record<string, unknown>) => weldbooksApi.post<ApiResponse<{ id: string }>>('/payments', data),
  deletePayment: (id: string) => weldbooksApi.delete<ApiResponse<unknown>>(`/payments/${id}`),

  // Reports
  getProfitLoss: (params?: { from?: string; to?: string }) => weldbooksApi.get<ApiResponse<unknown>>(`/accounting-reports/profit-loss${buildQuery(params || {})}`),
  getBalanceSheet: (params?: { asOf?: string }) => weldbooksApi.get<ApiResponse<unknown>>(`/accounting-reports/balance-sheet${buildQuery(params || {})}`),
  getTrialBalance: (params?: { from?: string; to?: string }) => weldbooksApi.get<ApiResponse<unknown>>(`/accounting-reports/trial-balance${buildQuery(params || {})}`),
  getAgedReceivables: () => weldbooksApi.get<ApiResponse<unknown>>('/accounting-reports/aged-receivables'),
  getAgedPayables: () => weldbooksApi.get<ApiResponse<unknown>>('/accounting-reports/aged-payables'),
  getVatSummary: (params?: { from?: string; to?: string }) => weldbooksApi.get<ApiResponse<unknown>>(`/accounting-reports/vat-summary${buildQuery(params || {})}`),
  getGeneralLedger: (params: { accountId: string; from?: string; to?: string; page?: number; pageSize?: number }) =>
    weldbooksApi.get<ApiResponse<unknown>>(`/accounting-reports/general-ledger${buildQuery(params)}`),
  getCashFlow: (params?: { from?: string; to?: string }) =>
    weldbooksApi.get<ApiResponse<unknown>>(`/accounting-reports/cash-flow${buildQuery(params || {})}`),
  getRevenueByCustomer: (params?: { from?: string; to?: string }) =>
    weldbooksApi.get<ApiResponse<unknown>>(`/accounting-reports/revenue-by-customer${buildQuery(params || {})}`),
  getExpenseByCategory: (params?: { from?: string; to?: string }) =>
    weldbooksApi.get<ApiResponse<unknown>>(`/accounting-reports/expense-by-category${buildQuery(params || {})}`),
};
