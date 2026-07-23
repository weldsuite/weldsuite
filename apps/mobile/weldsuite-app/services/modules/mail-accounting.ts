/**
 * W1b module package #2 — MAIL + ACCOUNTING (+ document scanning) for the
 * weldsuite-app legacy API facade, backed by the unified app-api.
 *
 * Every method preserves the legacy `services/api.ts` name, signature, and
 * screen-facing `ApiResponse<T>` shape (`{ success, data }` / list
 * `{ items, meta }`), while calling app-api (`/api/...`) underneath via the
 * shared `appApiClient` from `services/app-api.ts` (created by the facade
 * assembler — see P1/core-user).
 *
 * Endpoint map (legacy mobile-api-worker /v1 → app-api /api):
 *  - /v1/mail/accounts                → /api/mail-accounts
 *  - /v1/mail/accounts/:id/labels     → /api/mail-labels?accountId=
 *  - /v1/mail/messages*               → /api/mail-messages (cursor-paginated;
 *                                       a per-query cursor map emulates the
 *                                       legacy page-based infinite scroll)
 *  - /v1/mail/drafts*   [was dead]    → /api/mail-drafts
 *  - /v1/mail/ai/draft  [was a 503]   → /api/mail-ai/draft (real, credit-metered
 *                                       — may now fail with 402 on empty wallet)
 *  - /v1/mail/send                    → /api/mail-accounts/:id/send
 *  - /v1/mail/stats                   → /api/mail-messages/stats
 *  - /v1/mail/scheduled*              → /api/mail-scheduled
 *  - /v1/accounting/dashboard         → /api/accounting-dashboard (+ invoice counts)
 *  - /v1/accounting/invoices          → /api/invoices
 *  - /v1/accounting/transactions      → /api/bank-transactions
 *  - /v1/accounting/ledger [dead]     → /api/accounting-reports/general-ledger
 *                                       (accountId required) or /api/journal-entries
 *  - /v1/accounting/banks* [dead]     → /api/bank-accounts (+ /api/bank-transactions)
 *  - /v1/accounting/analytics [dead]  → composed from /api/accounting-dashboard
 *                                       + /api/accounting-reports/expense-by-category
 *  - /v1/accounting/inbox [dead]      → /api/accounting-documents
 *  - /v1/accounting/vat-returns* [dead] → /api/vat-returns (+ /calculate, /:id/file)
 *  - /v1/accounting/reconciliation* [dead] → /api/bank-transactions
 *                                       (/unreconciled, /:id/suggestions, /:id/reconcile)
 *  - /v1/accounting/bills*            → /api/bills (+ /api/payments for mark-paid)
 *  - /v1/documents/* [dead]           → /api/storage upload-token flow
 *                                       + /api/accounting-documents
 */

import { formatEmailTime, formatEmailDate, formatShortTime } from '@/utils/dateFormatter';
import type { ApiResponse, PaginatedResponse } from '@weldsuite/mobile-ui/types';

// Created by the facade assembler (P1). Exports `appApiClient`
// (get/getRaw/post/put/patch/delete/postForm, throws ApiError on non-2xx,
// 204 → {}) plus `setAppApiTokenGetter` and `APP_API_URL`.
import { appApiClient } from '../app-api';

// ============================================================================
// Types (moved verbatim from services/api.ts so the facade can re-export them)
// ============================================================================

export interface EmailAccount {
  id: string;
  emailAddress: string;
  displayName: string;
  provider: string;
  unreadCount: number;
  totalMessages: number;
  isDefault: boolean;
  isActive: boolean;
  lastSyncedAt?: string;
  signature?: string;
}

export interface EmailLabel {
  id: string;
  slug: string;
  name: string;
  color?: string;
  isSystem: boolean;
  unreadCount?: number;
  totalCount?: number;
}

export interface Email {
  id: string;
  emailAccountId: string;
  from: string;
  fromName?: string;
  fromEmail: string;
  subject: string;
  preview?: string;
  date: string;
  time: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachment: boolean;
  labels: string[];
  category: 'primary' | 'social' | 'promotions' | 'updates';
}

export interface EmailDetail extends Email {
  to: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  body?: string;
  bodyHtml?: string;
  sentAt?: string;
  receivedAt: string;
  attachments: EmailAttachment[];
  threadId?: string;
  inReplyTo?: string;
  isDraft: boolean;
  isSent: boolean;
  importance: string;
}

export interface EmailAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  downloadUrl?: string;
}

export interface EmailStats {
  totalUnread: number;
  inboxCount: number;
  inboxUnread: number;
  sentCount: number;
  draftCount: number;
  trashCount: number;
  spamCount: number;
  archivedCount: number;
  starredCount: number;
}

export interface SendEmailRequest {
  emailAccountId: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body?: string;
  bodyHtml?: string;
  inReplyTo?: string;
  threadId?: string;
  attachmentIds?: string[];
  saveToDrafts?: boolean;
  draftId?: string;
}

export interface AccountingDashboardStats {
  totalRevenue: number;
  todayRevenue: number;
  weekRevenue: number;
  monthRevenue: number;
  totalExpenses: number;
  pendingInvoices: number;
  overdueInvoices: number;
  paidInvoices: number;
  totalTransactions: number;
  profitMargin: number;
  totalAccounts: number;
  taxOwed: number;
}

export interface RecentInvoice {
  id: string;
  clientName: string;
  amount: number;
  status: 'draft' | 'sent' | 'paid' | 'overdue';
  dueDate: string;
}

export interface RecentTransaction {
  id: string;
  description: string;
  amount: number;
  type: 'income' | 'expense';
  date: string;
}

export interface InvoiceItem {
  id: string;
  description: string;
  quantity: number;
  rate: number;
  amount: number;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  clientName: string;
  clientEmail: string;
  status: 'draft' | 'sent' | 'viewed' | 'paid' | 'overdue' | 'cancelled' | 'refunded';
  totalAmount: number;
  items: InvoiceItem[];
  billingAddress?: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  issueDate: string;
  dueDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntry {
  id: string;
  date: string;
  reference: string;
  description: string;
  accountName: string;
  accountCode: string;
  debit: number;
  credit: number;
  balance: number;
  type: 'debit' | 'credit';
}

export interface BankAccount {
  id: string;
  accountName: string;
  accountNumber: string;
  bankName: string;
  type: 'checking' | 'savings' | 'credit' | 'investment' | 'loan' | 'other';
  balance: number;
  availableBalance?: number;
  currency: string;
  status: 'connected' | 'syncing' | 'error' | 'disconnected';
  lastSync: string;
  institution?: {
    name: string;
    color?: string;
  };
}

export interface BankTransaction {
  id: string;
  date: string;
  description: string;
  reference?: string;
  amount: number;
  type: 'deposit' | 'withdrawal';
  category: string;
  status: string;
}

export interface BankAccountDetail {
  account: BankAccount;
  transactions: BankTransaction[];
}

export interface AccountingAnalytics {
  summary: {
    revenue: { amount: number; change: number };
    expenses: { amount: number; change: number };
    profit: { amount: number; change: number };
    outstanding: { amount: number; change: number };
  };
  monthlyRevenue: { month: string; revenue: number }[];
  expenseBreakdown: { category: string; amount: number; percentage: number }[];
  invoiceBreakdown: { paid: number; pending: number; draft: number; overdue: number };
}

export interface AccountingInboxItem {
  id: string;
  type: 'invoice' | 'expense';
  title: string;
  sender: string;
  amount: number;
  date: string;
  read: boolean;
  createdAt: string;
}

export interface DocumentUpload {
  id: string;
  filename: string;
  fileUrl: string;
  thumbnailUrl?: string;
  fileType: string;
  fileSize: number;
  entityType: string;
  entityId?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface VatReturn {
  id: string;
  period: string; // Q1, Q2, Q3, Q4 or month
  year: number;
  status: 'draft' | 'pending' | 'submitted' | 'accepted' | 'rejected';
  dueDate: string;
  submittedAt?: string;
  vatDue: number;
  vatReclaimable: number;
  netVat: number;
  totalSales: number;
  totalPurchases: number;
  createdAt: string;
  updatedAt: string;
}

export interface VatReturnDetail extends VatReturn {
  salesBreakdown: VatBreakdown[];
  purchasesBreakdown: VatBreakdown[];
  adjustments: VatAdjustment[];
  notes?: string;
}

export interface VatBreakdown {
  rate: number; // VAT rate (0, 9, 21, etc.)
  taxableAmount: number;
  vatAmount: number;
  description?: string;
}

export interface VatAdjustment {
  id: string;
  description: string;
  amount: number;
  type: 'correction' | 'bad_debt' | 'other';
}

export interface VatSummary {
  outputVat: number; // VAT on sales
  inputVat: number; // VAT on purchases
  netVat: number; // outputVat - inputVat
  transactions: number;
  invoices: number;
  expenses: number;
}

export interface ReconciliationStats {
  totalUnmatched: number;
  totalMatched: number;
  matchedThisMonth: number;
  pendingAmount: number;
  accounts: ReconciliationAccountSummary[];
}

export interface ReconciliationAccountSummary {
  accountId: string;
  accountName: string;
  bankName: string;
  unmatchedCount: number;
  lastReconciled?: string;
}

export interface UnmatchedTransaction {
  id: string;
  bankAccountId: string;
  bankAccountName: string;
  date: string;
  description: string;
  amount: number;
  type: 'credit' | 'debit';
  reference?: string;
  counterpartyName?: string;
  suggestedMatchCount: number;
  confidence?: number;
}

export interface SuggestedMatch {
  journalEntryId: string;
  description: string;
  amount: number;
  date: string;
  accountName: string;
  confidence: number; // 0-100
  matchReason: string;
}

export interface Bill {
  id: string;
  billNumber: string;
  supplierId: string;
  supplierName: string;
  issueDate: string;
  dueDate: string;
  status: 'draft' | 'pending' | 'approved' | 'paid' | 'overdue' | 'cancelled';
  subtotal: number;
  taxAmount: number;
  total: number;
  currency: string;
  paidAt?: string;
  documentUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BillDetail extends Bill {
  lineItems: BillLineItem[];
  notes?: string;
  paymentMethod?: string;
  paymentReference?: string;
  attachments?: string[];
}

export interface BillLineItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  accountId?: string;
  accountName?: string;
}

export interface CreateBillRequest {
  supplierId: string;
  billNumber?: string;
  issueDate: string;
  dueDate: string;
  lineItems: {
    description: string;
    quantity: number;
    unitPrice: number;
    taxRate: number;
    accountId?: string;
  }[];
  notes?: string;
  documentId?: string;
}

// ============================================================================
// Local envelope types + adapters
// ============================================================================

type Json = Record<string, any>;

interface DataEnvelope<T = Json> {
  data: T;
}

interface ListEnvelope<T = Json> {
  data: T[];
  pagination?: { totalCount: number; hasMore: boolean; cursor: string | null };
}

/**
 * app-api's client THROWS on non-2xx (ApiError carries `.status`) and on
 * connectivity failures (NetworkError). Adapt back to the legacy
 * `{ success: false, error: { title, message } }` shape.
 * Structural check (no `isApiError` import) so this file only depends on
 * `../app-api` — `@weldsuite/api-client` errors keep the `isApiError` flag.
 */
function toError(err: unknown): { success: false; error: { title: string; message: string } } {
  const e = err as { isApiError?: boolean; status?: number; message?: string } | null;
  if (e && typeof e === 'object' && e.isApiError === true && typeof e.status === 'number') {
    return {
      success: false,
      error: { title: `api_error_${e.status}`, message: e.message || 'Request failed' },
    };
  }
  return {
    success: false,
    error: {
      title: 'network_error',
      message: err instanceof Error ? err.message : 'Request failed',
    },
  };
}

function buildQuery(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  }
  const query = searchParams.toString();
  return query ? `?${query}` : '';
}

/** Coerce app-api numeric strings ("123.45") to numbers for the UI. */
function num(value: unknown): number {
  if (typeof value === 'number') return value;
  const parsed = parseFloat(String(value ?? '0'));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Legacy `{ items, meta }` pagination block the list screens read. */
function legacyMeta(page: number, limit: number, totalCount: number) {
  const totalPages = limit > 0 ? Math.ceil(totalCount / limit) : 0;
  return {
    page,
    limit,
    total: totalCount,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

// ----------------------------------------------------------------------------
// Cursor map — app-api lists are cursor-paginated while the mail screens do
// page-increment infinite scroll. We remember the "next page" cursor per
// query signature so page N>1 sends the stored cursor; page 1 resets.
// ----------------------------------------------------------------------------

const cursorStore = new Map<string, string>();

function cursorKey(scope: string, params: Record<string, unknown>): string {
  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) stable[key] = params[key];
  return `${scope}:${JSON.stringify(stable)}`;
}

function cursorFor(scope: string, params: Record<string, unknown>, page: number): string | undefined {
  const key = cursorKey(scope, params);
  if (page <= 1) {
    for (const k of Array.from(cursorStore.keys())) {
      if (k.startsWith(`${key}#`)) cursorStore.delete(k);
    }
    return undefined;
  }
  return cursorStore.get(`${key}#${page}`);
}

function rememberCursor(
  scope: string,
  params: Record<string, unknown>,
  page: number,
  nextCursor: string | null | undefined,
): void {
  if (!nextCursor) return;
  cursorStore.set(`${cursorKey(scope, params)}#${page + 1}`, nextCursor);
}

// ----------------------------------------------------------------------------
// Email transforms (moved from the legacy service — same date formatting)
// ----------------------------------------------------------------------------

function isValidISODate(dateString: string): boolean {
  if (!dateString) return false;
  const date = new Date(dateString);
  return !isNaN(date.getTime()) && dateString.includes('T'); // ISO format includes 'T'
}

/**
 * Adapt an app-api mail_messages row to the legacy list-item shape.
 * The legacy /v1 list returned the raw row (with `from` as JSONB
 * `{ email, name }`), so we keep the row intact and add the aliases the
 * screens/interfaces also use (`emailAccountId`, `hasAttachment`,
 * `fromName` / `fromEmail`).
 */
function mapMessageRow(row: Json): Json {
  const from = row?.from && typeof row.from === 'object' ? (row.from as Json) : null;
  return {
    ...row,
    emailAccountId: row.emailAccountId ?? row.accountId,
    hasAttachment: !!(row.hasAttachments ?? row.hasAttachment ?? (row.attachmentCount ?? 0) > 0),
    fromName: from ? (from.name ?? undefined) : row.fromName,
    fromEmail: from ? (from.email ?? '') : (row.fromEmail ?? ''),
    labels: row.labels ?? [],
  };
}

/** Transform email to use the local timezone (legacy behavior). */
function transformEmail(email: Json): Email {
  const timestamp = email.receivedDate || email.receivedAt;
  if (timestamp && isValidISODate(timestamp)) {
    return {
      ...email,
      date: formatEmailDate(timestamp),
      time: formatShortTime(timestamp),
    } as unknown as Email;
  }
  return email as unknown as Email;
}

/** Transform email detail to use the local timezone (legacy behavior). */
function transformEmailDetail(email: Json): EmailDetail {
  const timestamp = email.receivedDate || email.receivedAt;
  if (timestamp && isValidISODate(timestamp)) {
    return {
      ...email,
      date: formatEmailDate(timestamp),
      time: formatEmailTime(timestamp),
    } as unknown as EmailDetail;
  }
  return email as unknown as EmailDetail;
}

/** Adapt an app-api message (+attachments) row to the legacy detail shape. */
function mapMessageDetail(row: Json): Json {
  return {
    ...mapMessageRow(row),
    receivedAt: row.receivedAt ?? row.receivedDate,
    sentAt: row.sentAt ?? row.sentDate,
    body: row.body ?? row.textBody ?? undefined,
    bodyHtml: row.bodyHtml ?? row.htmlBody ?? undefined,
    importance: row.importance ?? row.priority ?? 'normal',
    isSent: row.isSent ?? row.sendStatus === 'sent',
    isDraft: !!row.isDraft,
    attachments: Array.isArray(row.attachments)
      ? (row.attachments as Json[]).map((a) => ({
          id: String(a.id),
          filename: String(a.filename ?? a.fileName ?? ''),
          contentType: String(a.contentType ?? ''),
          size: num(a.size),
          downloadUrl: (a.downloadUrl ?? a.storagePath ?? undefined) as string | undefined,
        }))
      : [],
  };
}

/** Legacy `to`/`cc`/`bcc` are comma-separated strings; app-api wants arrays. */
function splitAddresses(value?: string): string[] {
  if (!value) return [];
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// ----------------------------------------------------------------------------
// Accounting transforms
// ----------------------------------------------------------------------------

/** Map an app-api invoices row to the legacy Invoice aliases screens read. */
function mapInvoiceRow(row: Json): Json {
  return {
    ...row,
    clientName: row.clientName ?? row.contactName ?? '',
    clientEmail: row.clientEmail ?? row.contactEmail ?? '',
    totalAmount: num(row.totalAmount ?? row.total),
    items: row.items ?? [],
  };
}

/** Map an app-api bank_accounts row to the legacy BankAccount shape. */
function mapBankAccountRow(row: Json): BankAccount {
  return {
    ...row,
    id: String(row.id),
    accountName: String(row.accountName ?? row.name ?? ''),
    accountNumber: String(row.accountNumber ?? row.iban ?? ''),
    bankName: String(row.bankName ?? row.bank ?? row.name ?? ''),
    type: (row.type as BankAccount['type']) ?? 'checking',
    balance: num(row.balance ?? row.currentBalance),
    currency: String(row.currency ?? 'EUR'),
    status: (row.status as BankAccount['status']) ?? 'connected',
    lastSync: String(row.lastSync ?? row.lastImportDate ?? row.updatedAt ?? ''),
  } as unknown as BankAccount;
}

/** Map an app-api bank_transactions row to the legacy BankTransaction shape. */
function mapBankTransactionRow(row: Json): BankTransaction {
  const amount = num(row.amount);
  return {
    ...row,
    id: String(row.id),
    date: String(row.date ?? ''),
    description: String(row.description ?? row.counterpartyName ?? ''),
    reference: (row.reference ?? undefined) as string | undefined,
    amount,
    type: amount >= 0 ? 'deposit' : 'withdrawal',
    category: String(row.category ?? ''),
    status: String(row.status ?? ''),
  } as unknown as BankTransaction;
}

/** Map an app-api bills row to the legacy Bill shape (supplier* aliases). */
function mapBillRow(row: Json): Bill {
  return {
    ...row,
    id: String(row.id),
    billNumber: String(row.billNumber ?? ''),
    supplierId: String(row.supplierId ?? row.contactId ?? ''),
    supplierName: String(row.supplierName ?? row.contactName ?? ''),
    subtotal: num(row.subtotal),
    taxAmount: num(row.taxAmount ?? row.taxTotal),
    total: num(row.total),
    currency: String(row.currency ?? 'EUR'),
  } as unknown as Bill;
}

/**
 * Map an app-api vat_returns row (rubrieken r5a/r5b/r5c) to the legacy
 * VatReturn shape. `filed` becomes `submitted` (legacy status enum).
 */
function mapVatReturnRow(row: Json): VatReturn {
  const start = row.periodStart ? new Date(String(row.periodStart)) : null;
  const rubrieken = (row.rubrieken ?? {}) as Json;
  const vatDue = num(rubrieken.r5a);
  const vatReclaimable = num(rubrieken.r5b);
  const status = row.status === 'filed' ? 'submitted' : String(row.status ?? 'draft');
  return {
    ...row,
    id: String(row.id),
    period:
      (row.periodLabel as string | null) ??
      (start ? `Q${Math.floor(start.getMonth() / 3) + 1}` : ''),
    year: start ? start.getFullYear() : num(row.year),
    status,
    dueDate: String(row.dueDate ?? row.periodEnd ?? ''),
    submittedAt: (row.filedAt ?? row.submittedAt ?? undefined) as string | undefined,
    vatDue,
    vatReclaimable,
    netVat: rubrieken.r5c != null ? num(rubrieken.r5c) : vatDue - vatReclaimable,
    totalSales: num(rubrieken.r1a),
    totalPurchases: 0,
    createdAt: String(row.createdAt ?? ''),
    updatedAt: String(row.updatedAt ?? ''),
  } as unknown as VatReturn;
}

/** Convert the legacy `{ period: 'Q1'|month, year }` pair to an ISO range. */
function vatPeriodRange(period: string, year: number): {
  periodType: 'monthly' | 'quarterly' | 'yearly';
  from: string;
  to: string;
  label: string;
} {
  const quarter = /^q([1-4])$/i.exec(String(period).trim());
  if (quarter) {
    const q = parseInt(quarter[1], 10);
    const startMonth = (q - 1) * 3;
    return {
      periodType: 'quarterly',
      from: new Date(Date.UTC(year, startMonth, 1)).toISOString(),
      to: new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59)).toISOString(),
      label: `${year} Q${q}`,
    };
  }
  const month = parseInt(String(period), 10);
  if (!Number.isNaN(month) && month >= 1 && month <= 12) {
    return {
      periodType: 'monthly',
      from: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
      to: new Date(Date.UTC(year, month, 0, 23, 59, 59)).toISOString(),
      label: `${year}-${String(month).padStart(2, '0')}`,
    };
  }
  return {
    periodType: 'yearly',
    from: new Date(Date.UTC(year, 0, 1)).toISOString(),
    to: new Date(Date.UTC(year, 11, 31, 23, 59, 59)).toISOString(),
    label: String(year),
  };
}

/** Map a document row (+ optional public URL) to the legacy DocumentUpload. */
function mapDocumentRow(row: Json, fileUrl?: string, entityType?: string): DocumentUpload {
  const rawStatus = String(row.status ?? 'pending');
  const status: DocumentUpload['status'] =
    rawStatus === 'processed' || rawStatus === 'completed'
      ? 'completed'
      : rawStatus === 'processing'
        ? 'processing'
        : rawStatus === 'failed' || rawStatus === 'error'
          ? 'failed'
          : 'pending';
  return {
    ...row,
    id: String(row.id),
    filename: String(row.filename ?? row.fileName ?? ''),
    fileUrl: fileUrl ?? String(row.fileUrl ?? ''),
    fileType: String(row.fileType ?? row.mimeType ?? ''),
    fileSize: num(row.fileSize),
    entityType: entityType ?? String(row.entityType ?? row.type ?? ''),
    status,
    createdAt: String(row.createdAt ?? ''),
    updatedAt: String(row.updatedAt ?? ''),
  } as unknown as DocumentUpload;
}

/** Legacy `entityType` param → app-api documents `type` enum. */
function documentTypeFor(entityType?: string): string {
  switch (entityType) {
    case 'expense':
      return 'receipt';
    case 'invoice':
    case 'bill':
      return 'purchase_invoice';
    default:
      return 'other';
  }
}

// ============================================================================
// Module — exactly the P2 method surface (19 mail + 25 accounting + 4 docs)
// ============================================================================

export const mailAccountingModule = {
  // ==========================================================================
  // MAIL
  // ==========================================================================

  async getEmailAccounts(): Promise<ApiResponse<EmailAccount[]>> {
    try {
      const res = await appApiClient.get<ListEnvelope>('/mail-accounts');
      // TODO(phase-out): app-api's account list has no per-account
      // unreadCount/totalMessages — /api/mail-messages/stats is global only.
      const accounts = (res.data ?? []).map(
        (a: Json) =>
          ({
            ...a,
            id: String(a.id),
            emailAddress: String(a.emailAddress ?? a.email ?? ''),
            displayName: String(a.displayName ?? a.name ?? a.email ?? ''),
            provider: String(a.provider ?? ''),
            unreadCount: num(a.unreadCount),
            totalMessages: num(a.totalMessages),
            isDefault: !!a.isDefault,
            isActive: a.isActive != null ? !!a.isActive : a.status === 'active',
            lastSyncedAt: (a.lastSyncedAt ?? a.lastSyncAt ?? undefined) as string | undefined,
            signature: (a.signature ?? undefined) as string | undefined,
          }) as unknown as EmailAccount,
      );
      return { success: true, data: accounts };
    } catch (err) {
      return toError(err);
    }
  },

  async getLabels(accountId: string): Promise<ApiResponse<any[]>> {
    try {
      // /api/mail-labels rows carry slug/isSystem/messageCount — richer than
      // the /mail-accounts/:id/labels options list.
      const res = await appApiClient.get<DataEnvelope<Json[]>>(
        `/mail-labels${buildQuery({ accountId })}`,
      );
      const labels = (res.data ?? []).map((l: Json) => ({
        ...l,
        id: String(l.id),
        slug: String(l.slug ?? String(l.name ?? '').toLowerCase()),
        name: String(l.name ?? ''),
        color: (l.color ?? undefined) as string | undefined,
        isSystem: !!l.isSystem,
        totalCount: num(l.totalCount ?? l.messageCount),
      }));
      return { success: true, data: labels };
    } catch (err) {
      return toError(err);
    }
  },

  async getMessages(params?: {
    emailAccountId?: string;
    label?: string;
    search?: string;
    isRead?: boolean;
    isStarred?: boolean;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: string;
  }): Promise<ApiResponse<{ items: Email[]; meta: any }>> {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 25;
    // sortBy/sortOrder are not supported by app-api (fixed receivedDate desc)
    // — same effective order the inbox used.
    const query: Record<string, unknown> = {
      accountId: params?.emailAccountId,
      label: params?.label,
      search: params?.search,
      isRead: params?.isRead,
      isStarred: params?.isStarred,
      limit,
    };
    try {
      const cursor = cursorFor('mail-messages', query, page);
      const res = await appApiClient.get<ListEnvelope>(
        `/mail-messages${buildQuery({ ...query, cursor })}`,
      );
      rememberCursor('mail-messages', query, page, res.pagination?.cursor);
      const items = (res.data ?? []).map((row: Json) => transformEmail(mapMessageRow(row)));
      const totalCount = res.pagination?.totalCount ?? items.length;
      const meta = {
        ...legacyMeta(page, limit, totalCount),
        hasNext: res.pagination?.hasMore ?? false,
      };
      return { success: true, data: { items, meta } };
    } catch (err) {
      return toError(err);
    }
  },

  async getMessage(id: string): Promise<ApiResponse<EmailDetail>> {
    try {
      const res = await appApiClient.get<DataEnvelope>(`/mail-messages/${id}`);
      const row = res.data ?? {};
      // The legacy /v1 GET marked the message read server-side — preserve that.
      if (row && row.isRead === false) {
        try {
          await appApiClient.patch<DataEnvelope>(`/mail-messages/${id}`, { isRead: true });
          row.isRead = true;
        } catch {
          // non-fatal — the read flag just stays unset
        }
      }
      return { success: true, data: transformEmailDetail(mapMessageDetail(row)) };
    } catch (err) {
      return toError(err);
    }
  },

  async getDraft(id: string): Promise<ApiResponse<any>> {
    try {
      const res = await appApiClient.get<DataEnvelope>(`/mail-drafts/${id}`);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  },

  async getDrafts(accountId: string, page = 1, pageSize = 25): Promise<ApiResponse<any>> {
    const query: Record<string, unknown> = { accountId, limit: pageSize };
    try {
      const cursor = cursorFor('mail-drafts', query, page);
      const res = await appApiClient.get<ListEnvelope>(
        `/mail-drafts${buildQuery({ ...query, cursor })}`,
      );
      rememberCursor('mail-drafts', query, page, res.pagination?.cursor);
      const items = res.data ?? [];
      const totalCount = res.pagination?.totalCount ?? items.length;
      return {
        success: true,
        data: { items, meta: legacyMeta(page, pageSize, totalCount) },
      };
    } catch (err) {
      return toError(err);
    }
  },

  async generateAiDraft(data: {
    prompt: string;
    replyToMessageId?: string;
    accountId?: string;
    tone?: 'professional' | 'friendly' | 'casual';
    length?: 'short' | 'medium' | 'long';
  }): Promise<ApiResponse<{ subject: string; body: string }>> {
    try {
      // Real AI now (was a /v1 503 stub). Credit-metered — an empty wallet
      // surfaces as api_error_402 through toError.
      const res = await appApiClient.post<{ success: boolean; data: { subject: string; body: string } }>(
        '/mail-ai/draft',
        data,
      );
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  },

  async getThread(messageId: string): Promise<ApiResponse<any[]>> {
    try {
      const res = await appApiClient.get<DataEnvelope<{ threadId: string; messages: Json[] }>>(
        `/mail-messages/${messageId}/thread`,
      );
      const messages = (res.data?.messages ?? []).map((msg: Json) =>
        transformEmailDetail(mapMessageDetail(msg)),
      );
      return { success: true, data: messages };
    } catch (err) {
      return toError(err);
    }
  },

  async markAsRead(id: string, isRead: boolean): Promise<ApiResponse<void>> {
    try {
      await appApiClient.patch<DataEnvelope>(`/mail-messages/${id}`, { isRead });
      return { success: true };
    } catch (err) {
      return toError(err);
    }
  },

  async toggleStar(id: string): Promise<ApiResponse<void>> {
    try {
      // The legacy /v1 endpoint toggled server-side; app-api's PATCH needs the
      // explicit value — fetch-then-invert.
      const current = await appApiClient.get<DataEnvelope>(`/mail-messages/${id}`);
      await appApiClient.patch<DataEnvelope>(`/mail-messages/${id}`, {
        isStarred: !current.data?.isStarred,
      });
      return { success: true };
    } catch (err) {
      return toError(err);
    }
  },

  async deleteEmail(id: string): Promise<ApiResponse<void>> {
    try {
      await appApiClient.delete<void>(`/mail-messages/${id}`); // 204
      return { success: true };
    } catch (err) {
      return toError(err);
    }
  },

  async archiveEmail(id: string): Promise<ApiResponse<void>> {
    try {
      // Same call the platform's useArchiveMailMessage issues (uppercase
      // system label; labels JSONB is the source of truth).
      await appApiClient.patch<DataEnvelope>(`/mail-messages/${id}`, { labels: ['ARCHIVE'] });
      return { success: true };
    } catch (err) {
      return toError(err);
    }
  },

  async sendEmail(request: SendEmailRequest): Promise<ApiResponse<EmailDetail>> {
    try {
      const to = splitAddresses(request.to);
      const cc = splitAddresses(request.cc);
      const bcc = splitAddresses(request.bcc);

      if (request.saveToDrafts) {
        const draftBody = {
          subject: request.subject,
          to,
          ...(cc.length ? { cc } : {}),
          ...(bcc.length ? { bcc } : {}),
          ...(request.body ? { body: request.body } : {}),
          ...(request.bodyHtml ? { htmlBody: request.bodyHtml } : {}),
          ...(request.inReplyTo ? { inReplyTo: request.inReplyTo } : {}),
          ...(request.attachmentIds?.length ? { attachmentIds: request.attachmentIds } : {}),
        };
        const res = request.draftId
          ? await appApiClient.patch<DataEnvelope>(`/mail-drafts/${request.draftId}`, draftBody)
          : await appApiClient.post<DataEnvelope>('/mail-drafts', {
              accountId: request.emailAccountId,
              ...draftBody,
            });
        return { success: true, data: res.data as unknown as EmailDetail };
      }

      // TODO(phase-out): app-api's send schema takes inline `attachments`
      // ({ filename, contentType, size, fileKey }), not `attachmentIds` — ids
      // from the legacy attachment flow are dropped here.
      const res = await appApiClient.post<DataEnvelope>(
        `/mail-accounts/${request.emailAccountId}/send`,
        {
          to,
          ...(cc.length ? { cc } : {}),
          ...(bcc.length ? { bcc } : {}),
          subject: request.subject,
          ...(request.body ? { body: request.body } : {}),
          ...(request.bodyHtml ? { htmlBody: request.bodyHtml } : {}),
          ...(request.inReplyTo ? { inReplyTo: request.inReplyTo } : {}),
        },
      );

      // Sending a composed draft removes it (legacy behavior).
      if (request.draftId) {
        try {
          await appApiClient.delete<void>(`/mail-drafts/${request.draftId}`);
        } catch {
          // best-effort cleanup
        }
      }

      const sent = res.data ?? {};
      return {
        success: true,
        data: { ...sent, id: sent.messageId } as unknown as EmailDetail,
      };
    } catch (err) {
      return toError(err);
    }
  },

  async getEmailStats(accountId?: string): Promise<ApiResponse<EmailStats>> {
    try {
      const res = await appApiClient.get<DataEnvelope>(
        `/mail-messages/stats${buildQuery({ accountId })}`,
      );
      const s = res.data ?? {};
      // app-api exposes total/unread/inboxUnread/starred — the remaining
      // legacy counters have no equivalent and are zeroed.
      const stats: EmailStats = {
        totalUnread: num(s.totalUnread ?? s.unread),
        inboxCount: num(s.inboxCount ?? s.total),
        inboxUnread: num(s.inboxUnread),
        sentCount: num(s.sentCount),
        draftCount: num(s.draftCount),
        trashCount: num(s.trashCount),
        spamCount: num(s.spamCount),
        archivedCount: num(s.archivedCount),
        starredCount: num(s.starredCount ?? s.starred),
      };
      return { success: true, data: stats };
    } catch (err) {
      return toError(err);
    }
  },

  // Scheduled Emails

  async scheduleEmail(request: {
    accountId: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    body?: string;
    htmlBody?: string;
    scheduledFor: string;
    inReplyTo?: string;
    references?: string[];
    attachmentIds?: string[];
  }): Promise<ApiResponse<{ messageId: string; scheduledFor: string; triggerRunId: string }>> {
    try {
      // Body matches app-api's scheduleMailSchema 1:1 (send-scheduled-email-v2).
      const res = await appApiClient.post<DataEnvelope<{ messageId: string; scheduledFor: string; triggerRunId: string }>>(
        '/mail-scheduled',
        request,
      );
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  },

  async listScheduledEmails(accountId?: string): Promise<ApiResponse<any[]>> {
    try {
      const res = await appApiClient.get<DataEnvelope<Json[]>>(
        `/mail-scheduled${buildQuery({ accountId })}`,
      );
      return { success: true, data: (res.data ?? []).map((row: Json) => mapMessageRow(row)) };
    } catch (err) {
      return toError(err);
    }
  },

  async cancelScheduledEmail(messageId: string): Promise<ApiResponse<{ id: string }>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string }>>(
        `/mail-scheduled/${messageId}/cancel`,
        {},
      );
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  },

  async rescheduleEmail(
    messageId: string,
    scheduledFor: string,
  ): Promise<ApiResponse<{ scheduledFor: string }>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ scheduledFor: string }>>(
        `/mail-scheduled/${messageId}/reschedule`,
        { scheduledFor },
      );
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  },

  async sendScheduledNow(messageId: string): Promise<ApiResponse<{ id: string }>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string }>>(
        `/mail-scheduled/${messageId}/send-now`,
        {},
      );
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  },

  // ==========================================================================
  // ACCOUNTING
  // ==========================================================================

  async getAccountingDashboardStats(): Promise<ApiResponse<AccountingDashboardStats>> {
    try {
      const [dashboard, paid] = await Promise.all([
        appApiClient.get<DataEnvelope>('/accounting-dashboard'),
        appApiClient.get<ListEnvelope>('/invoices?status=paid&page=1&pageSize=1'),
      ]);
      const d = dashboard.data ?? {};
      const revenue = (d.revenue ?? {}) as Json;
      const expenses = (d.expenses ?? {}) as Json;
      const profit = (d.profit ?? {}) as Json;
      const receivables = (d.receivables ?? {}) as Json;
      const yearRevenue = num(revenue.year);
      const stats: AccountingDashboardStats = {
        totalRevenue: yearRevenue,
        // No day/week rollups on app-api's dashboard.
        todayRevenue: 0,
        weekRevenue: 0,
        monthRevenue: num(revenue.month),
        totalExpenses: num(expenses.year),
        pendingInvoices: num(receivables.outstandingCount),
        overdueInvoices: num(receivables.overdueCount),
        paidInvoices: paid.pagination?.totalCount ?? 0,
        totalTransactions: 0,
        profitMargin: yearRevenue > 0 ? (num(profit.year) / yearRevenue) * 100 : 0,
        totalAccounts: Array.isArray(d.bankAccounts) ? d.bankAccounts.length : 0,
        taxOwed: 0,
      };
      return { success: true, data: stats };
    } catch (err) {
      return toError(err);
    }
  },

  async getRecentInvoices(limit = 5): Promise<ApiResponse<RecentInvoice[]>> {
    try {
      const res = await appApiClient.get<ListEnvelope>(`/invoices?page=1&pageSize=${limit}`);
      const invoices = (res.data ?? []).map(
        (row: Json) => mapInvoiceRow(row) as unknown as RecentInvoice,
      );
      return {
        success: true,
        data: invoices.map((inv: RecentInvoice) => ({
          ...inv,
          amount: num((inv as unknown as Json).totalAmount),
        })),
      };
    } catch (err) {
      return toError(err);
    }
  },

  async getRecentTransactions(limit = 5): Promise<ApiResponse<RecentTransaction[]>> {
    try {
      const res = await appApiClient.get<ListEnvelope>(
        `/bank-transactions?page=1&pageSize=${limit}`,
      );
      const transactions = (res.data ?? []).map((row: Json) => {
        const amount = num(row.amount);
        return {
          ...row,
          id: String(row.id),
          description: String(row.description ?? row.counterpartyName ?? ''),
          amount,
          type: amount >= 0 ? 'income' : 'expense',
          date: String(row.date ?? ''),
        } as unknown as RecentTransaction;
      });
      return { success: true, data: transactions };
    } catch (err) {
      return toError(err);
    }
  },

  async getInvoices(params?: {
    page?: number;
    limit?: number;
    status?: string;
    search?: string;
  }): Promise<ApiResponse<PaginatedResponse<Invoice>>> {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 20;
    try {
      const res = await appApiClient.get<ListEnvelope>(
        `/invoices${buildQuery({ page, pageSize: limit, status: params?.status, search: params?.search })}`,
      );
      const items = (res.data ?? []).map((row: Json) => mapInvoiceRow(row)) as unknown as Invoice[];
      const totalCount = res.pagination?.totalCount ?? items.length;
      return {
        success: true,
        data: { items, data: items, meta: legacyMeta(page, limit, totalCount) },
      };
    } catch (err) {
      return toError(err);
    }
  },

  async getLedgerEntries(params?: {
    page?: number;
    limit?: number;
    accountId?: string;
    search?: string;
  }): Promise<ApiResponse<PaginatedResponse<LedgerEntry>>> {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 25;
    try {
      if (params?.accountId) {
        // Per-account drill-down with running balance.
        const res = await appApiClient.get<DataEnvelope>(
          `/accounting-reports/general-ledger${buildQuery({ accountId: params.accountId, page, pageSize: limit })}`,
        );
        const account = (res.data?.account ?? {}) as Json;
        const items = ((res.data?.lines ?? []) as Json[]).map((line: Json) => {
          const debit = num(line.debit);
          const credit = num(line.credit);
          return {
            ...line,
            id: String(line.id),
            date: String(line.entryDate ?? ''),
            reference: String(line.entryNumber ?? ''),
            description: String(line.description ?? ''),
            accountName: String(account.name ?? ''),
            accountCode: String(account.code ?? ''),
            debit,
            credit,
            balance: num(line.runningBalance),
            type: debit > 0 ? 'debit' : 'credit',
          } as unknown as LedgerEntry;
        });
        const totalCount = num(res.data?.pagination?.totalCount ?? items.length);
        return {
          success: true,
          data: { items, data: items, meta: legacyMeta(page, limit, totalCount) },
        };
      }

      // No accountId — list posted journal entries (tenant-wide ledger view).
      const res = await appApiClient.get<ListEnvelope>(
        `/journal-entries${buildQuery({ page, pageSize: limit, status: 'posted' })}`,
      );
      const items = (res.data ?? []).map((entry: Json) => {
        const debit = num(entry.totalDebit);
        const credit = num(entry.totalCredit);
        return {
          ...entry,
          id: String(entry.id),
          date: String(entry.date ?? ''),
          reference: String(entry.entryNumber ?? entry.reference ?? ''),
          description: String(entry.description ?? entry.memo ?? ''),
          accountName: '',
          accountCode: '',
          debit,
          credit,
          balance: debit - credit,
          type: debit >= credit ? 'debit' : 'credit',
        } as unknown as LedgerEntry;
      });
      const totalCount = res.pagination?.totalCount ?? items.length;
      return {
        success: true,
        data: { items, data: items, meta: legacyMeta(page, limit, totalCount) },
      };
    } catch (err) {
      return toError(err);
    }
  },

  async getBankAccounts(): Promise<ApiResponse<BankAccount[]>> {
    try {
      const res = await appApiClient.get<DataEnvelope<Json[]>>('/bank-accounts');
      return { success: true, data: (res.data ?? []).map((row: Json) => mapBankAccountRow(row)) };
    } catch (err) {
      return toError(err);
    }
  },

  async getBankAccount(id: string): Promise<ApiResponse<BankAccountDetail>> {
    try {
      const [accountRes, txRes] = await Promise.all([
        appApiClient.get<DataEnvelope>(`/bank-accounts/${id}`),
        appApiClient.get<ListEnvelope>(
          `/bank-transactions${buildQuery({ bankAccountId: id, page: 1, pageSize: 50 })}`,
        ),
      ]);
      return {
        success: true,
        data: {
          account: mapBankAccountRow(accountRes.data ?? {}),
          transactions: (txRes.data ?? []).map((row: Json) => mapBankTransactionRow(row)),
        },
      };
    } catch (err) {
      return toError(err);
    }
  },

  async getAccountingAnalytics(): Promise<ApiResponse<AccountingAnalytics>> {
    try {
      // Composed from the dashboard + expense report + per-status invoice
      // counts (period-over-period "change" deltas are not available → 0).
      const [dashboard, expenseReport, draft, sent, paid] = await Promise.all([
        appApiClient.get<DataEnvelope>('/accounting-dashboard'),
        appApiClient.get<DataEnvelope>('/accounting-reports/expense-by-category'),
        appApiClient.get<ListEnvelope>('/invoices?status=draft&page=1&pageSize=1'),
        appApiClient.get<ListEnvelope>('/invoices?status=sent&page=1&pageSize=1'),
        appApiClient.get<ListEnvelope>('/invoices?status=paid&page=1&pageSize=1'),
      ]);
      const d = dashboard.data ?? {};
      const revenue = num(((d.revenue ?? {}) as Json).year);
      const expenses = num(((d.expenses ?? {}) as Json).year);
      const profit = num(((d.profit ?? {}) as Json).year);
      const receivables = (d.receivables ?? {}) as Json;

      const categories = ((expenseReport.data?.categories ?? []) as Json[]);
      const grandTotal = num(expenseReport.data?.grandTotal) || 1;

      const analytics: AccountingAnalytics = {
        summary: {
          revenue: { amount: revenue, change: 0 },
          expenses: { amount: expenses, change: 0 },
          profit: { amount: profit, change: 0 },
          outstanding: { amount: num(receivables.outstanding), change: 0 },
        },
        monthlyRevenue: ((d.monthlyRevenue ?? []) as Json[]).map((m) => ({
          month: String(m.month ?? ''),
          revenue: num(m.total ?? m.revenue),
        })),
        expenseBreakdown: categories.map((cat: Json) => {
          const amount = num(cat.totalExpense);
          return {
            category: String(cat.accountName ?? ''),
            amount,
            percentage: Math.round((amount / grandTotal) * 100),
          };
        }),
        invoiceBreakdown: {
          paid: paid.pagination?.totalCount ?? 0,
          pending: sent.pagination?.totalCount ?? 0,
          draft: draft.pagination?.totalCount ?? 0,
          overdue: num(receivables.overdueCount),
        },
      };
      return { success: true, data: analytics };
    } catch (err) {
      return toError(err);
    }
  },

  async getAccountingInbox(params?: {
    page?: number;
    limit?: number;
    type?: 'invoice' | 'expense';
  }): Promise<ApiResponse<PaginatedResponse<AccountingInboxItem>>> {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 20;
    try {
      // The document inbox (upload → OCR → link/reject) is the app-api
      // equivalent of the legacy "inbox" feed.
      const res = await appApiClient.get<DataEnvelope<Json[]>>('/accounting-documents');
      let rows = res.data ?? [];
      if (params?.type) {
        const wanted = documentTypeFor(params.type);
        rows = rows.filter((row: Json) => String(row.type ?? '') === wanted);
      }
      const start = (page - 1) * limit;
      const items = rows.slice(start, start + limit).map(
        (row: Json) =>
          ({
            ...row,
            id: String(row.id),
            type: String(row.type ?? '') === 'receipt' ? 'expense' : 'invoice',
            title: String(row.originalFileName ?? row.fileName ?? ''),
            sender: String(row.emailFrom ?? row.vendorName ?? ''),
            amount: num(row.totalAmount ?? (row.extractedData as Json | undefined)?.total),
            date: String(row.createdAt ?? ''),
            read: String(row.status ?? 'pending') !== 'pending',
            createdAt: String(row.createdAt ?? ''),
          }) as unknown as AccountingInboxItem,
      );
      return {
        success: true,
        data: { items, data: items, meta: legacyMeta(page, limit, rows.length) },
      };
    } catch (err) {
      return toError(err);
    }
  },

  // VAT Returns

  async getVatReturns(params?: { year?: number; status?: string }): Promise<ApiResponse<VatReturn[]>> {
    try {
      const res = await appApiClient.get<DataEnvelope<Json[]>>('/vat-returns');
      let returns = (res.data ?? []).map((row: Json) => mapVatReturnRow(row));
      // app-api's list takes no filters — filter client-side like the old worker.
      if (params?.year) returns = returns.filter((r: VatReturn) => r.year === params.year);
      if (params?.status) returns = returns.filter((r: VatReturn) => String(r.status) === params.status);
      return { success: true, data: returns };
    } catch (err) {
      return toError(err);
    }
  },

  async getVatReturnDetails(id: string): Promise<ApiResponse<VatReturnDetail>> {
    try {
      const res = await appApiClient.get<DataEnvelope>(`/vat-returns/${id}`);
      const row = res.data ?? {};
      const rubrieken = (row.rubrieken ?? {}) as Json;
      const detail = {
        ...mapVatReturnRow(row),
        // The rubrieken model has no per-rate breakdown — surface 5a/5b as
        // single-line breakdowns so the detail screen has something to render.
        salesBreakdown: [
          { rate: 0, taxableAmount: num(rubrieken.r1a), vatAmount: num(rubrieken.r5a), description: 'Output VAT (5a)' },
        ],
        purchasesBreakdown: [
          { rate: 0, taxableAmount: 0, vatAmount: num(rubrieken.r5b), description: 'Input VAT (5b)' },
        ],
        adjustments: [],
        notes: (row.notes ?? undefined) as string | undefined,
      } as unknown as VatReturnDetail;
      return { success: true, data: detail };
    } catch (err) {
      return toError(err);
    }
  },

  async createVatReturn(data: { period: string; year: number }): Promise<ApiResponse<VatReturn>> {
    try {
      const range = vatPeriodRange(data.period, data.year);
      const res = await appApiClient.post<DataEnvelope>('/vat-returns/calculate', {
        periodType: range.periodType,
        periodStart: range.from,
        periodEnd: range.to,
        periodLabel: range.label,
      });
      return { success: true, data: mapVatReturnRow(res.data ?? {}) };
    } catch (err) {
      return toError(err);
    }
  },

  async submitVatReturn(id: string): Promise<ApiResponse<VatReturn>> {
    try {
      // Files the return (SBR/XBRL flow on app-api — not just a status flip).
      const res = await appApiClient.post<DataEnvelope>(`/vat-returns/${id}/file`, {});
      return { success: true, data: mapVatReturnRow(res.data ?? {}) };
    } catch (err) {
      return toError(err);
    }
  },

  async getVatSummary(period: string, year: number): Promise<ApiResponse<VatSummary>> {
    try {
      const range = vatPeriodRange(period, year);
      const res = await appApiClient.get<DataEnvelope>(
        `/accounting-reports/vat-summary${buildQuery({ from: range.from, to: range.to })}`,
      );
      const breakdown = ((res.data?.breakdown ?? []) as Json[]);
      let outputVat = 0;
      let inputVat = 0;
      for (const row of breakdown) {
        const tax = num(row.totalTax);
        if (tax >= 0) outputVat += tax;
        else inputVat += Math.abs(tax);
      }
      const summary: VatSummary = {
        outputVat,
        inputVat,
        netVat: outputVat - inputVat,
        transactions: breakdown.length,
        invoices: 0,
        expenses: 0,
      };
      return { success: true, data: summary };
    } catch (err) {
      return toError(err);
    }
  },

  // Bank Reconciliation

  async getReconciliationStats(): Promise<ApiResponse<ReconciliationStats>> {
    try {
      const [unmatched, matched, accounts] = await Promise.all([
        appApiClient.get<ListEnvelope>('/bank-transactions?status=unreconciled&page=1&pageSize=100'),
        appApiClient.get<ListEnvelope>('/bank-transactions?status=reconciled&page=1&pageSize=1'),
        appApiClient.get<DataEnvelope<Json[]>>('/bank-accounts'),
      ]);
      const unmatchedRows = unmatched.data ?? [];
      const pendingAmount = unmatchedRows.reduce(
        (sum: number, t: Json) => sum + Math.abs(num(t.amount)),
        0,
      );
      const stats: ReconciliationStats = {
        totalUnmatched: unmatched.pagination?.totalCount ?? unmatchedRows.length,
        totalMatched: matched.pagination?.totalCount ?? 0,
        matchedThisMonth: 0,
        pendingAmount,
        accounts: (accounts.data ?? []).map((account: Json) => ({
          accountId: String(account.id),
          accountName: String(account.name ?? ''),
          bankName: String(account.bankName ?? account.name ?? ''),
          unmatchedCount: unmatchedRows.filter((t: Json) => t.bankAccountId === account.id).length,
        })),
      };
      return { success: true, data: stats };
    } catch (err) {
      return toError(err);
    }
  },

  async getUnmatchedTransactions(params?: {
    bankAccountId?: string;
    limit?: number;
  }): Promise<ApiResponse<UnmatchedTransaction[]>> {
    try {
      const res = await appApiClient.get<ListEnvelope>(
        `/bank-transactions${buildQuery({
          status: 'unreconciled',
          bankAccountId: params?.bankAccountId,
          page: 1,
          pageSize: params?.limit ?? 20,
        })}`,
      );
      const items = (res.data ?? []).map((row: Json) => {
        const amount = num(row.amount);
        return {
          ...row,
          id: String(row.id),
          bankAccountId: String(row.bankAccountId ?? ''),
          bankAccountName: String(row.bankAccountName ?? ''),
          date: String(row.date ?? ''),
          description: String(row.description ?? row.counterpartyName ?? ''),
          amount,
          type: amount >= 0 ? 'credit' : 'debit',
          reference: (row.reference ?? undefined) as string | undefined,
          counterpartyName: (row.counterpartyName ?? undefined) as string | undefined,
          suggestedMatchCount: 0,
        } as unknown as UnmatchedTransaction;
      });
      return { success: true, data: items };
    } catch (err) {
      return toError(err);
    }
  },

  async getSuggestedMatches(transactionId: string): Promise<ApiResponse<SuggestedMatch[]>> {
    try {
      const res = await appApiClient.get<DataEnvelope<Json[]>>(
        `/bank-transactions/${transactionId}/suggestions`,
      );
      // Suggestions are open invoices/bills (there is no journal-entry-level
      // matching on app-api) — the entity id rides in `journalEntryId` so the
      // reconciliation screen's pass-through to matchTransaction keeps working.
      const matches = (res.data ?? []).map(
        (s: Json) =>
          ({
            journalEntryId: String(s.id),
            description: [String(s.type) === 'invoice' ? 'Invoice' : 'Bill', s.number, s.contactName]
              .filter(Boolean)
              .join(' · '),
            amount: num(s.amount),
            date: '',
            accountName: String(s.contactName ?? ''),
            confidence: Math.round(num(s.confidence) * 100),
            matchReason: String(s.type ?? ''),
          }) as SuggestedMatch,
      );
      return { success: true, data: matches };
    } catch (err) {
      return toError(err);
    }
  },

  async matchTransaction(transactionId: string, journalEntryId: string): Promise<ApiResponse<void>> {
    try {
      // The id passed in is a suggestion id (invoice/bill) — resolve its type
      // from the suggestions endpoint, defaulting to a manual reconciliation.
      let type: 'invoice' | 'bill' | 'manual' = 'manual';
      try {
        const s = await appApiClient.get<DataEnvelope<Json[]>>(
          `/bank-transactions/${transactionId}/suggestions`,
        );
        const found = (s.data ?? []).find((sg: Json) => String(sg.id) === journalEntryId);
        const foundType = found ? String(found.type) : '';
        if (foundType === 'invoice' || foundType === 'bill') type = foundType;
      } catch {
        // fall through as manual reconciliation against the given id
      }
      await appApiClient.post<DataEnvelope>(`/bank-transactions/${transactionId}/reconcile`, {
        type,
        entityId: journalEntryId,
      });
      return { success: true };
    } catch (err) {
      return toError(err);
    }
  },

  async createManualMatch(
    transactionId: string,
    data: { description: string; accountId: string; amount: number },
  ): Promise<ApiResponse<void>> {
    try {
      await appApiClient.post<DataEnvelope>(`/bank-transactions/${transactionId}/reconcile`, {
        type: 'manual',
        categoryAccountId: data.accountId,
      });
      return { success: true };
    } catch (err) {
      return toError(err);
    }
  },

  // Bills

  async getBills(params?: { status?: string; supplierId?: string }): Promise<ApiResponse<Bill[]>> {
    try {
      const res = await appApiClient.get<ListEnvelope>(
        `/bills${buildQuery({ status: params?.status, contactId: params?.supplierId, page: 1, pageSize: 100 })}`,
      );
      return { success: true, data: (res.data ?? []).map((row: Json) => mapBillRow(row)) };
    } catch (err) {
      return toError(err);
    }
  },

  async getBillDetails(id: string): Promise<ApiResponse<BillDetail>> {
    try {
      const res = await appApiClient.get<DataEnvelope>(`/bills/${id}`);
      const row = res.data ?? {};
      const detail = {
        ...mapBillRow(row),
        lineItems: ((row.items ?? row.lineItems ?? []) as Json[]).map(
          (item) =>
            ({
              ...item,
              id: String(item.id ?? ''),
              description: String(item.description ?? ''),
              quantity: num(item.quantity),
              unitPrice: num(item.unitPrice),
              taxRate: num(item.taxRate),
              taxAmount: num(item.taxAmount),
              total: num(item.total ?? item.lineTotal),
              accountId: (item.accountId ?? undefined) as string | undefined,
            }) as unknown as BillLineItem,
        ),
        notes: (row.notes ?? undefined) as string | undefined,
      } as unknown as BillDetail;
      return { success: true, data: detail };
    } catch (err) {
      return toError(err);
    }
  },

  async createBill(data: CreateBillRequest): Promise<ApiResponse<Bill>> {
    try {
      const res = await appApiClient.post<DataEnvelope>('/bills', {
        contactId: data.supplierId,
        ...(data.billNumber ? { billNumber: data.billNumber } : {}),
        issueDate: data.issueDate,
        dueDate: data.dueDate,
        ...(data.notes ? { notes: data.notes } : {}),
        ...(data.documentId ? { sourceDocumentId: data.documentId } : {}),
        // Line-item numbers are strings on app-api.
        items: (data.lineItems ?? []).map((item, index) => ({
          description: item.description,
          quantity: String(item.quantity ?? 1),
          unitPrice: String(item.unitPrice ?? 0),
          taxRate: String(item.taxRate ?? 0),
          ...(item.accountId ? { accountId: item.accountId } : {}),
          sortOrder: index,
        })),
      });
      return { success: true, data: mapBillRow(res.data ?? {}) };
    } catch (err) {
      return toError(err);
    }
  },

  async updateBill(id: string, data: Partial<CreateBillRequest>): Promise<ApiResponse<Bill>> {
    try {
      // PUT /api/bills/:id accepts field edits on DRAFT bills only — same
      // constraint the accounting model enforces everywhere else.
      const body: Json = {};
      if (data.supplierId !== undefined) body.contactId = data.supplierId;
      if (data.billNumber !== undefined) body.billNumber = data.billNumber;
      if (data.issueDate !== undefined) body.issueDate = data.issueDate;
      if (data.dueDate !== undefined) body.dueDate = data.dueDate;
      if (data.notes !== undefined) body.notes = data.notes;
      if (data.documentId !== undefined) body.sourceDocumentId = data.documentId;
      if (data.lineItems) {
        body.items = data.lineItems.map((item, index) => ({
          description: item.description,
          quantity: String(item.quantity ?? 1),
          unitPrice: String(item.unitPrice ?? 0),
          taxRate: String(item.taxRate ?? 0),
          ...(item.accountId ? { accountId: item.accountId } : {}),
          sortOrder: index,
        }));
      }
      const res = await appApiClient.put<DataEnvelope>(`/bills/${id}`, body);
      return { success: true, data: mapBillRow(res.data ?? {}) };
    } catch (err) {
      return toError(err);
    }
  },

  async markBillPaid(
    id: string,
    paymentData: { paidAt: string; paymentMethod: string },
  ): Promise<ApiResponse<Bill>> {
    try {
      // Bills are marked paid by recording an outgoing payment on app-api.
      const { data: bill } = await appApiClient.get<DataEnvelope>(`/bills/${id}`);
      if (!bill?.contactId) {
        return {
          success: false,
          error: {
            title: 'missing_contact',
            message: 'Bill has no contact — a contact is required to record a payment.',
          },
        };
      }
      await appApiClient.post<DataEnvelope>('/payments', {
        type: 'sent',
        amount: String(bill.balanceDue ?? bill.total ?? '0'),
        date: paymentData.paidAt || new Date().toISOString(),
        billId: id,
        contactId: bill.contactId,
        paymentMethod: paymentData.paymentMethod || 'manual',
      });
      const refreshed = await appApiClient.get<DataEnvelope>(`/bills/${id}`);
      return { success: true, data: mapBillRow(refreshed.data ?? {}) };
    } catch (err) {
      return toError(err);
    }
  },

  async deleteBill(id: string): Promise<ApiResponse<void>> {
    try {
      await appApiClient.delete<void>(`/bills/${id}`); // 204
      return { success: true };
    } catch (err) {
      return toError(err);
    }
  },

  // ==========================================================================
  // DOCUMENT SCANNING & FILE UPLOAD
  // ==========================================================================

  /**
   * Upload a scanned document. app-api has no multipart endpoint for
   * accounting documents — the flow is the storage upload-token broker:
   *   1. POST /api/storage/generate-upload-url → { uploadUrl, uploadToken, fileKey }
   *   2. PUT the raw bytes to uploadUrl (the token IS the auth)
   *   3. POST /api/storage/confirm-upload → { file }
   *   4. POST /api/accounting-documents with the fileKey → document record
   *
   * The scan screen builds a React Native FormData with a `file` part
   * ({ uri, type, name }) and an `entityType` string part.
   */
  async uploadDocument(formData: FormData): Promise<ApiResponse<DocumentUpload>> {
    try {
      // React Native FormData exposes getParts(); extract the file + fields.
      const parts =
        (
          formData as unknown as {
            getParts?: () => {
              fieldName?: string;
              string?: string;
              uri?: string;
              name?: string;
              type?: string;
            }[];
          }
        ).getParts?.() ?? [];
      const filePart = parts.find((part) => !!part.uri);
      const entityType =
        parts.find((part) => part.fieldName === 'entityType' && typeof part.string === 'string')
          ?.string ?? 'expense';
      if (!filePart?.uri) {
        return { success: false, error: 'No file part in upload form data' };
      }
      const fileName = filePart.name || `scan_${Date.now()}.jpg`;
      const contentType = filePart.type || 'image/jpeg';

      // Read the file bytes up front — generateUploadUrlSchema REQUIRES
      // fileSize, so the broker call is rejected with a 400 without it.
      const fileResponse = await fetch(filePart.uri);
      const blob = await fileResponse.blob();

      // 1. Broker an upload slot.
      const slot = await appApiClient.post<{
        success: boolean;
        uploadUrl: string;
        uploadToken: string;
        fileKey: string;
      }>('/storage/generate-upload-url', {
        fileName,
        contentType,
        fileSize: blob.size,
        entityType: 'accounting-document',
        folder: 'accounting',
      });

      // 2. PUT the raw bytes (token-authenticated URL — no headers needed).
      const putResponse = await fetch(slot.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: blob,
      });
      if (!putResponse.ok) {
        return { success: false, error: `Upload failed: ${putResponse.status}` };
      }

      // 3. Confirm so the broker verifies the object landed in R2.
      const confirmed = await appApiClient.post<{
        success: boolean;
        file?: { url?: string; fileSize?: number };
      }>('/storage/confirm-upload', {
        uploadToken: slot.uploadToken,
        fileKey: slot.fileKey,
      });

      // 4. Create the accounting document record.
      const doc = await appApiClient.post<DataEnvelope>('/accounting-documents', {
        type: documentTypeFor(entityType),
        fileName,
        originalFileName: fileName,
        fileKey: slot.fileKey,
        fileSize: num(confirmed.file?.fileSize ?? blob.size),
        mimeType: contentType,
        source: 'scan',
      });

      return {
        success: true,
        data: mapDocumentRow(doc.data ?? {}, confirmed.file?.url, entityType),
      };
    } catch (error) {
      console.error('[API] Document upload error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Network error during upload',
      };
    }
  },

  async getDocuments(entityType: string, entityId?: string): Promise<ApiResponse<DocumentUpload[]>> {
    try {
      // app-api filters by document `type` (not entityType/entityId — links to
      // bills/invoices live on the document row itself).
      const res = await appApiClient.get<DataEnvelope<Json[]>>(
        `/accounting-documents${buildQuery({ type: documentTypeFor(entityType) })}`,
      );
      let rows = res.data ?? [];
      if (entityId) rows = rows.filter((row: Json) => row.linkedEntityId === entityId);
      return {
        success: true,
        data: rows.map((row: Json) => mapDocumentRow(row, undefined, entityType)),
      };
    } catch (err) {
      return toError(err);
    }
  },

  async deleteDocument(documentId: string): Promise<ApiResponse<void>> {
    try {
      await appApiClient.delete<void>(`/accounting-documents/${documentId}`); // 204
      return { success: true };
    } catch (err) {
      return toError(err);
    }
  },

  async getDocumentStatus(documentId: string): Promise<ApiResponse<DocumentUpload>> {
    try {
      const res = await appApiClient.get<DataEnvelope>(`/accounting-documents/${documentId}`);
      return { success: true, data: mapDocumentRow(res.data ?? {}) };
    } catch (err) {
      return toError(err);
    }
  },
};

export default mailAccountingModule;
