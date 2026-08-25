/**
 * Domain models for WeldBooks mobile.
 *
 * These mirror the `app-api` response shapes (see apps/workers/app-api/src/routes/*)
 * rather than the retired mobile-api-worker's. Money is a decimal STRING
 * everywhere app-api returns one — parse with `toNumber()` from lib/currency at
 * the point of display, never store it as a float.
 */

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * `overdue` is computed by app-api from dueDate + balanceDue — it is never a
 * stored status and cannot be set through the API.
 */
export type InvoiceStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'partially_paid'
  | 'paid'
  | 'overdue'
  | 'cancelled'
  | 'uncollectible';

export interface Invoice {
  id: string;
  invoiceNumber: string;
  contactId?: string;
  contactName: string;
  contactEmail?: string;
  issueDate: string;
  dueDate: string;
  status: InvoiceStatus;
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  amountPaid?: string;
  balanceDue: string;
  notes?: string;
  reference?: string;
  items?: InvoiceItem[];
  payments?: Payment[];
  createdAt: string;
}

export interface InvoiceItem {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  lineTotal: string;
  taxAmount?: string;
  accountId?: string;
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

export type BillStatus =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'partially_paid'
  | 'paid'
  | 'overdue'
  | 'rejected';

export interface Bill {
  id: string;
  billNumber: string;
  contactId?: string;
  contactName: string;
  issueDate: string;
  dueDate: string;
  status: BillStatus;
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  amountPaid?: string;
  balanceDue: string;
  notes?: string;
  reference?: string;
  sourceDocumentId?: string;
  items?: BillItem[];
  createdAt: string;
}

export interface BillItem {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  lineTotal: string;
  taxAmount?: string;
  accountId?: string;
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// Banking
// ---------------------------------------------------------------------------

export interface BankAccount {
  id: string;
  name: string;
  iban?: string;
  bankName?: string;
  accountType: string;
  currency: string;
  /** Decimal string from app-api. */
  currentBalance: string;
  /** Parsed convenience value added by the API adapter. */
  balance: number;
  isActive: boolean;
  lastImportDate?: string | null;
}

export interface BankAccountDetail extends BankAccount {
  transactions: BankTransaction[];
}

export type BankTransactionStatus = 'unreconciled' | 'reconciled' | 'ignored';

export interface BankTransaction {
  id: string;
  bankAccountId: string;
  date: string;
  description: string;
  /** Parsed convenience value added by the API adapter. Negative = outgoing. */
  amount: number;
  currency: string;
  status: BankTransactionStatus;
  counterpartyName?: string;
  reference?: string;
  runningBalance?: number;
}

export interface MatchSuggestion {
  id: string;
  type: 'invoice' | 'bill';
  description: string;
  amount: number;
  /** 0–1 match confidence from app-api's suggestion scorer. */
  confidence: number;
}

export interface UnmatchedTransaction extends BankTransaction {
  suggestedMatches: MatchSuggestion[];
}

export interface ReconciliationStats {
  totalUnmatched: number;
  totalMatched: number;
  pendingAmount: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export interface Payment {
  id: string;
  invoiceId?: string;
  billId?: string;
  contactId?: string;
  amount: string;
  date: string;
  paymentMethod?: string;
  reference?: string;
}

// ---------------------------------------------------------------------------
// VAT
// ---------------------------------------------------------------------------

export type VatReturnStatus = 'draft' | 'submitted' | 'accepted' | 'rejected';

export interface VatReturn {
  id: string;
  /** `periodLabel` from app-api, or a derived `YYYY-MM`. */
  period: string;
  year: number;
  status: VatReturnStatus;
  /** Rubriek 5a — output (sales) VAT. */
  salesTax: number;
  /** Rubriek 5b — input (purchase) VAT. */
  purchaseTax: number;
  /** Rubriek 5c — net payable/reclaimable. */
  netAmount: number;
  currency: string;
  periodStart?: string;
  periodEnd?: string;
  filedAt?: string | null;
  dueDate?: string | null;
}

export interface VatReturnDetail extends VatReturn {
  /** Raw rubriek map (r1a, r5a, …) as returned by app-api. */
  rubrieken: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Ledger / config
// ---------------------------------------------------------------------------

export interface TaxRate {
  id: string;
  name: string;
  rate: string;
  isActive: boolean;
}

export interface GlAccount {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  balance?: string;
  isActive: boolean;
}

/** A legal entity — every accounting endpoint is scoped to one. */
export interface AccountingEntity {
  id: string;
  name: string;
  legalName?: string;
  jurisdictionCode: string;
  baseCurrency: string;
  isDefault?: boolean;
  isActive?: boolean;
}

export interface Jurisdiction {
  code: string;
  name: string;
  currency?: string;
}

export interface AppSettings {
  currency: string;
  fiscalYearStart: string;
  entityName?: string;
  jurisdictionCode?: string;
  vatNumber?: string;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export type ContactRole = 'customer' | 'supplier' | 'both';

export interface Contact {
  id: string;
  name: string;
  email: string;
  type: ContactRole;
  phone?: string;
  vatNumber?: string;
  city?: string;
  country?: string;
}

export interface ContactBalance {
  receivable: number;
  payable: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/**
 * Mirrors `GET /api/accounting-dashboard` so the mobile KPI grid shows the same
 * figures as the platform's `weldbooks/dashboard/components/kpi-cards.tsx`.
 */
export interface DashboardData {
  revenue: { month: number; year: number };
  expenses: { month: number; year: number };
  profit: { month: number; year: number };
  receivables: { outstanding: number; outstandingCount: number; overdue: number; overdueCount: number };
  payables: { outstanding: number; outstandingCount: number };
  pendingDocuments: number;
  bankAccounts: BankAccount[];
  recentInvoices: Invoice[];
  currency: string;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface ProfitLossData {
  period?: unknown;
  revenue: number;
  expenses: number;
  netProfit: number;
  profitMargin: number;
  currency: string;
}

export interface BalanceSheetSection {
  label: string;
  accounts: { code: string; name: string; balance: number }[];
  total: number;
}

export interface BalanceSheetData {
  assets: BalanceSheetSection;
  liabilities: BalanceSheetSection;
  equity: BalanceSheetSection;
  totalAssets: number;
  totalLiabilitiesAndEquity: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// Search / expenses
// ---------------------------------------------------------------------------

export type SearchResultType = 'invoice' | 'bill' | 'contact';

export interface SearchResult {
  id: string;
  title: string;
  description: string;
  type: SearchResultType;
}

export interface QuickExpense {
  amount: number;
  category: string;
  description?: string;
  vendorName?: string;
  date?: string;
  documentId?: string;
  accountId?: string;
  taxRate?: number;
}

/** Prefill payload from `POST /bills/from-document/:id` after OCR. */
export interface BillPrefill {
  contactName: string | null;
  externalReference: string | null;
  issueDate: string | null;
  dueDate: string | null;
  currency: string | null;
  items: Array<{
    description: string;
    quantity: string;
    unitPrice: string;
    taxRate: string | null;
    sortOrder: number;
  }>;
  subtotal: number | null;
  taxTotal: number | null;
  total: number | null;
  sourceDocumentId: string;
  matchedContactId: string | null;
  confidence?: { overall: number; fields: Record<string, number> };
}

export type ExpenseCategory =
  | 'food'
  | 'transport'
  | 'office'
  | 'travel'
  | 'supplies'
  | 'utilities'
  | 'insurance'
  | 'other';

/** Cursor-paginated list envelope, normalised for the list screens. */
export interface Paged<T> {
  items: T[];
  totalCount: number;
  hasMore: boolean;
}
