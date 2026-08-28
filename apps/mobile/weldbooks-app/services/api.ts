/**
 * app-api client for WeldBooks mobile.
 *
 * Talks to the unified app-api (`/api/*`, apps/workers/app-api). Built on
 * `createClientApi` from `@weldsuite/api-client` (throws on non-2xx; app-api
 * envelopes are `{ data }` for single items and `{ data, pagination }` for
 * lists — the `/api` prefix is added by the client).
 *
 * This layer owns every difference between app-api's wire format and the
 * models the screens consume (types/accounting.ts):
 *  - Money stays a decimal STRING on entities that round-trip to the API;
 *    fields the UI only ever displays (balances, report totals) are parsed to
 *    numbers here so screens don't each re-parse.
 *  - Invoices/bills REQUIRE a `contactId`; the quick forms collect a free-text
 *    name, so `resolveContactId()` finds or creates the accounting contact.
 *  - Status flips map to dedicated endpoints (`PATCH /:id/send`,
 *    `PATCH /:id/status`, `POST /:id/record-payment`, `PATCH /:id/approve`).
 *
 * Endpoints app-api deliberately does NOT have — do not add wrappers for them:
 *  - `PUT /invoices/:id` / `PUT /bills/:id`. Issued documents are immutable;
 *    correct a mistake with a credit note (`POST /invoices/:id/credit-note`)
 *    or delete the draft and re-create it.
 *  - Setting an invoice to `overdue`. app-api derives it from dueDate +
 *    balanceDue.
 *  - A bulk offline-queue endpoint. `uploadOfflineQueue` replays items one by
 *    one against the regular routes.
 */

import { createClientApi } from '@weldsuite/api-client/client';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import type {
  ApiResponse,
  Workspace,
  WorkspaceWithMembership,
  InstalledApp,
} from '@weldsuite/mobile-ui/types';
import type {
  AccountingEntity,
  AppSettings,
  BalanceSheetData,
  BankAccount,
  BankAccountDetail,
  BankTransaction,
  Bill,
  BillPrefill,
  Contact,
  ContactBalance,
  DashboardData,
  GlAccount,
  Invoice,
  Jurisdiction,
  MatchSuggestion,
  Paged,
  Payment,
  ProfitLossData,
  SearchResult,
  SearchResultType,
  TaxRate,
  UnmatchedTransaction,
  UserPreferences,
  VatReturn,
  VatReturnDetail,
} from '@/types/accounting';

/** app-api base URL. Defaults to the local wrangler dev port (`apps/workers/app-api`). */
export const APP_API_URL = process.env.EXPO_PUBLIC_APP_API_URL || 'http://localhost:8789';
/** Legacy export name — some screens import { API_URL }. */
export const API_URL = APP_API_URL;

type Json = Record<string, unknown>;

interface ListEnvelope<T = Json> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

interface DataEnvelope<T = Json> {
  data: T;
}

/** Coerce app-api numeric strings ("123.45") to numbers for display. */
function num(value: unknown): number {
  if (typeof value === 'number') return value;
  const parsed = parseFloat(String(value ?? '0'));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value);
}

function nullableStr(value: unknown): string | null {
  if (value == null || value === '') return null;
  return String(value);
}

function toBillPrefill(raw: Json): BillPrefill {
  const items = Array.isArray(raw.items) ? raw.items : [];
  const confidence = raw.confidence as Json | undefined;
  return {
    contactName: nullableStr(raw.contactName),
    externalReference: nullableStr(raw.externalReference),
    issueDate: nullableStr(raw.issueDate)?.slice(0, 10) ?? null,
    dueDate: nullableStr(raw.dueDate)?.slice(0, 10) ?? null,
    currency: nullableStr(raw.currency),
    items: items.map((item, idx) => {
      const row = (item ?? {}) as Json;
      return {
        description: str(row.description),
        quantity: str(row.quantity ?? '1'),
        unitPrice: str(row.unitPrice ?? '0'),
        taxRate: row.taxRate == null || row.taxRate === '' ? null : str(row.taxRate),
        sortOrder: typeof row.sortOrder === 'number' ? row.sortOrder : idx,
      };
    }),
    subtotal: raw.subtotal == null ? null : num(raw.subtotal),
    taxTotal: raw.taxTotal == null ? null : num(raw.taxTotal),
    total: raw.total == null ? null : num(raw.total),
    sourceDocumentId: str(raw.sourceDocumentId),
    matchedContactId: nullableStr(raw.matchedContactId),
    confidence:
      confidence && typeof confidence === 'object'
        ? {
            overall: num(confidence.overall),
            fields: (confidence.fields as Record<string, number>) ?? {},
          }
        : undefined,
  };
}

interface LineItemInput {
  description: string;
  quantity?: number | string;
  unitPrice: number | string;
  taxRateId?: string;
  taxRate?: number | string;
  accountId?: string;
  sortOrder?: number;
}

/** Map the mobile form's numeric line items to app-api's string fields. */
function toApiItems(items: LineItemInput[]) {
  return items.map((item, index) => ({
    description: item.description,
    quantity: String(item.quantity ?? 1),
    unitPrice: String(item.unitPrice ?? 0),
    ...(item.taxRateId ? { taxRateId: item.taxRateId } : {}),
    taxRate: String(item.taxRate ?? 0),
    ...(item.accountId ? { accountId: item.accountId } : {}),
    sortOrder: item.sortOrder ?? index,
  }));
}

function page<T>(res: ListEnvelope<T>): Paged<T> {
  return {
    items: res.data ?? [],
    totalCount: res.pagination?.totalCount ?? res.data?.length ?? 0,
    hasMore: res.pagination?.hasMore ?? false,
  };
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
}

// ---------------------------------------------------------------------------
// Token wiring
// ---------------------------------------------------------------------------

let accessToken: string | null = null;
let organizationId: string | null = null;
let tokenRefreshCallback: (() => Promise<string | null>) | null = null;
/** Selected administration — sent as `X-Accounting-Entity-Id` on every request. */
let accountingEntityId: string | null = null;

async function getToken(): Promise<string | null> {
  if (tokenRefreshCallback) {
    try {
      const fresh = await tokenRefreshCallback();
      if (fresh) accessToken = fresh;
    } catch (err) {
      console.error('Token refresh failed:', err);
    }
  }
  return accessToken;
}

const client = createClientApi({
  baseUrl: APP_API_URL,
  getToken,
  getExtraHeaders: (): Record<string, string> => {
    if (!accountingEntityId) return {};
    return { 'X-Accounting-Entity-Id': accountingEntityId };
  },
});

const workspacesApi = createWorkspacesApi(client);

class WeldBooksApi {
  setAccessToken(token: string | null) {
    accessToken = token;
  }

  /**
   * Kept for API compatibility. app-api resolves the workspace from the
   * Clerk JWT's active-organization claim, so no header is sent.
   */
  setOrganizationId(orgId: string | null | undefined) {
    organizationId = orgId || null;
  }

  getOrganizationId(): string | null {
    return organizationId;
  }

  /**
   * Scopes subsequent accounting calls to this legal entity. Mirrors the
   * platform weldbooks-client: app-api reads `X-Accounting-Entity-Id` and
   * falls back to the workspace default when it is unset.
   */
  setAccountingEntityId(id: string | null) {
    accountingEntityId = id;
  }

  getAccountingEntityId(): string | null {
    return accountingEntityId;
  }

  setTokenRefreshCallback(callback: (() => Promise<string | null>) | null) {
    tokenRefreshCallback = callback;
  }

  // ========== Workspace ==========

  /**
   * app-api has no single "current workspace" endpoint; returning a failure
   * lets WorkspaceProvider fall back to the active Clerk org (the source of
   * truth for which workspace is current). Same approach as weldmail-app.
   */
  async getCurrentWorkspace(): Promise<ApiResponse<Workspace>> {
    return { success: false };
  }

  async getUserWorkspaces(): Promise<ApiResponse<WorkspaceWithMembership[]>> {
    try {
      const { data: workspaces } = await workspacesApi.list();
      // WorkspaceProvider expects WorkspaceWithMembership[]. WorkspaceSummary.id
      // is the Clerk org id (what setActive/switchWorkspace expects).
      const mapped = workspaces.map((w) => ({
        id: w.id,
        clerkOrgId: w.id,
        name: w.name,
        slug: w.slug,
        imageUrl: w.imageUrl ?? undefined,
        isActive: true,
        role: w.role,
        membershipStatus: 'active',
      })) as unknown as WorkspaceWithMembership[];
      return { success: true, data: mapped };
    } catch {
      return { success: false, data: [] };
    }
  }

  async getInstalledApps(): Promise<InstalledApp[]> {
    try {
      // Returns { data: string[] } of installed app codes — map to InstalledApp[].
      const { data: codes } = await client.get<DataEnvelope<string[]>>('/dashboard/installed-apps');
      return (codes ?? []).map((code, i) => ({
        id: code,
        workspaceId: '',
        appCode: code,
        name: code,
        status: 'active',
        displayOrder: i,
      })) as unknown as InstalledApp[];
    } catch {
      return [];
    }
  }

  // ========== Accounting entities ==========
  // Every accounting endpoint is entity-scoped; without one they all fail with
  // `400 No accounting entity resolved`. The entity gate (contexts/
  // AccountingEntityContext) calls these before rendering the app.

  async getEntities(): Promise<AccountingEntity[]> {
    const res = await client.get<DataEnvelope<Json[]>>('/accounting-entities');
    return (res.data ?? []).map((row) => ({
      id: str(row.id),
      name: str(row.name),
      legalName: row.legalName ? str(row.legalName) : undefined,
      jurisdictionCode: str(row.jurisdictionCode ?? row.jurisdiction, 'NL'),
      baseCurrency: str(row.baseCurrency, 'EUR'),
      isDefault: Boolean(row.isDefault),
      isActive: row.isActive !== false,
    }));
  }

  async getJurisdictions(): Promise<Jurisdiction[]> {
    const res = await client.get<DataEnvelope<Json[]>>('/accounting-entities/jurisdictions');
    return (res.data ?? []).map((row) => ({
      code: str(row.code),
      name: str(row.name ?? row.code),
      currency: row.currency ? str(row.currency) : undefined,
    }));
  }

  /**
   * Creates the workspace's first legal entity. `seedDefaults` lets the
   * jurisdiction adapter install the localized chart of accounts, tax rates and
   * number sequences — without it the entity exists but can't issue anything.
   */
  async createEntity(data: {
    name: string;
    legalName?: string;
    jurisdictionCode: string;
    baseCurrency?: string;
    vatNumber?: string;
    isDefault?: boolean;
  }): Promise<AccountingEntity> {
    const res = await client.post<DataEnvelope>('/accounting-entities', {
      name: data.name,
      ...(data.legalName ? { legalName: data.legalName } : {}),
      jurisdictionCode: data.jurisdictionCode,
      baseCurrency: data.baseCurrency ?? 'EUR',
      ...(data.vatNumber ? { vatNumber: data.vatNumber } : {}),
      isDefault: data.isDefault ?? true,
      seedDefaults: true,
    });
    const row = res.data ?? {};
    return {
      id: str(row.id),
      name: str(row.name, data.name),
      legalName: row.legalName ? str(row.legalName) : undefined,
      jurisdictionCode: str(row.jurisdictionCode, data.jurisdictionCode),
      baseCurrency: str(row.baseCurrency, data.baseCurrency ?? 'EUR'),
      isDefault: Boolean(row.isDefault),
    };
  }

  // ========== Dashboard ==========

  /**
   * Composes the mobile dashboard from `/accounting-dashboard` (the same payload
   * the platform's KPI cards read) plus a short recent-invoice list.
   */
  async getDashboard(): Promise<DashboardData> {
    const [dashboard, recent] = await Promise.all([
      client.get<DataEnvelope>('/accounting-dashboard'),
      client.get<ListEnvelope<Invoice>>(`/invoices?${qs({ page: 1, pageSize: 5 })}`),
    ]);

    const d = dashboard.data ?? {};
    const revenue = (d.revenue ?? {}) as Json;
    const expenses = (d.expenses ?? {}) as Json;
    const profit = (d.profit ?? {}) as Json;
    const receivables = (d.receivables ?? {}) as Json;
    const payables = (d.payables ?? {}) as Json;

    return {
      revenue: { month: num(revenue.month), year: num(revenue.year) },
      expenses: { month: num(expenses.month), year: num(expenses.year) },
      profit: { month: num(profit.month), year: num(profit.year) },
      receivables: {
        outstanding: num(receivables.outstanding),
        outstandingCount: num(receivables.outstandingCount),
        overdue: num(receivables.overdue),
        overdueCount: num(receivables.overdueCount),
      },
      payables: {
        outstanding: num(payables.outstanding),
        outstandingCount: num(payables.outstandingCount),
      },
      pendingDocuments: num(d.pendingDocuments),
      bankAccounts: ((d.bankAccounts ?? []) as Json[]).map(toBankAccount),
      recentInvoices: recent.data ?? [],
      currency: str(d.currency, 'EUR'),
    };
  }

  // ========== Invoices ==========

  async getInvoices(params?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    contactId?: string;
    fromDate?: string;
    toDate?: string;
  }): Promise<Paged<Invoice>> {
    const res = await client.get<ListEnvelope<Invoice>>(
      `/invoices?${qs({
        page: params?.page ?? 1,
        pageSize: params?.limit ?? 20,
        search: params?.search,
        status: params?.status,
        contactId: params?.contactId,
        from: params?.fromDate,
        to: params?.toDate,
      })}`,
    );
    return page(res);
  }

  async getInvoice(id: string): Promise<Invoice> {
    const res = await client.get<DataEnvelope<Invoice>>(`/invoices/${id}`);
    return res.data;
  }

  async createInvoice(data: {
    contactId?: string;
    contactName: string;
    contactEmail?: string;
    issueDate: string;
    dueDate: string;
    currency?: string;
    notes?: string;
    reference?: string;
    items: LineItemInput[];
  }): Promise<Invoice> {
    const contactId =
      data.contactId ?? (await this.resolveContactId(data.contactName, data.contactEmail));

    const res = await client.post<DataEnvelope<Invoice>>('/invoices', {
      contactId,
      contactName: data.contactName,
      ...(data.contactEmail ? { contactEmail: data.contactEmail } : {}),
      issueDate: data.issueDate,
      dueDate: data.dueDate,
      ...(data.currency ? { currency: data.currency } : {}),
      ...(data.notes ? { notes: data.notes } : {}),
      ...(data.reference ? { reference: data.reference } : {}),
      items: toApiItems(data.items),
    });
    return res.data;
  }

  /** Locks the draft and assigns its definitive number from the entity sequence. */
  async finalizeInvoice(id: string): Promise<Invoice> {
    const res = await client.post<DataEnvelope<Invoice>>(`/invoices/${id}/finalize`, {});
    return res.data;
  }

  async sendInvoice(id: string): Promise<Invoice> {
    const res = await client.patch<DataEnvelope<Invoice>>(`/invoices/${id}/send`);
    return res.data;
  }

  /** Only `cancelled` and `uncollectible` are settable; everything else is derived. */
  async setInvoiceStatus(id: string, status: 'cancelled' | 'uncollectible'): Promise<Invoice> {
    const res = await client.patch<DataEnvelope<Invoice>>(`/invoices/${id}/status`, { status });
    return res.data;
  }

  /** Records a payment against an invoice. Omit `amount` to settle the full balance. */
  async recordInvoicePayment(
    id: string,
    options?: { amount?: number | string; date?: string; paymentMethod?: string; reference?: string },
  ): Promise<Payment> {
    let amount = options?.amount;
    if (amount === undefined) {
      const invoice = await this.getInvoice(id);
      amount = invoice.balanceDue ?? invoice.total ?? '0';
    }
    const res = await client.post<DataEnvelope<Payment>>(`/invoices/${id}/record-payment`, {
      amount: String(amount),
      date: options?.date ?? new Date().toISOString(),
      paymentMethod: options?.paymentMethod ?? 'manual',
      ...(options?.reference ? { reference: options.reference } : {}),
    });
    return res.data;
  }

  async duplicateInvoice(id: string): Promise<Invoice> {
    const res = await client.post<DataEnvelope<Invoice>>(`/invoices/${id}/duplicate`, {});
    return res.data;
  }

  /** Issues a credit note reversing the invoice — the correct way to fix an issued document. */
  async createCreditNote(id: string): Promise<Invoice> {
    const res = await client.post<DataEnvelope<Invoice>>(`/invoices/${id}/credit-note`, {});
    return res.data;
  }

  async deleteInvoice(id: string): Promise<void> {
    await client.delete(`/invoices/${id}`);
  }

  /**
   * The rendered invoice document. Despite the `/pdf` path app-api returns
   * styled HTML, so the caller renders it in a WebView and shares the markup.
   * Uses `getRaw` because the response is not a JSON envelope.
   */
  async getInvoiceDocumentHtml(id: string): Promise<string> {
    const res = await client.getRaw(`/invoices/${id}/pdf`);
    return res.text();
  }

  // ========== Bills ==========

  async getBills(params?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }): Promise<Paged<Bill>> {
    const res = await client.get<ListEnvelope<Bill>>(
      `/bills?${qs({
        page: params?.page ?? 1,
        pageSize: params?.limit ?? 20,
        search: params?.search,
        status: params?.status,
      })}`,
    );
    return page(res);
  }

  async getBill(id: string): Promise<Bill> {
    const res = await client.get<DataEnvelope<Bill>>(`/bills/${id}`);
    return res.data;
  }

  async createBill(data: {
    contactId?: string;
    contactName: string;
    billNumber?: string;
    issueDate: string;
    dueDate: string;
    currency?: string;
    notes?: string;
    reference?: string;
    externalReference?: string;
    documentId?: string;
    items: LineItemInput[];
  }): Promise<Bill> {
    const contactId = data.contactId ?? (await this.resolveContactId(data.contactName));

    const res = await client.post<DataEnvelope<Bill>>('/bills', {
      contactId,
      contactName: data.contactName,
      ...(data.billNumber ? { billNumber: data.billNumber } : {}),
      issueDate: data.issueDate,
      dueDate: data.dueDate,
      ...(data.currency ? { currency: data.currency } : {}),
      ...(data.notes ? { notes: data.notes } : {}),
      ...(data.reference ? { reference: data.reference } : {}),
      ...(data.externalReference ? { externalReference: data.externalReference } : {}),
      ...(data.documentId ? { sourceDocumentId: data.documentId } : {}),
      items: toApiItems(data.items),
    });
    return res.data;
  }

  async approveBill(id: string): Promise<Bill> {
    const res = await client.patch<DataEnvelope<Bill>>(`/bills/${id}/approve`);
    return res.data;
  }

  async rejectBill(id: string, reason?: string): Promise<Bill> {
    const res = await client.patch<DataEnvelope<Bill>>(`/bills/${id}/reject`, {
      reason: reason || 'Rejected from the WeldBooks mobile app',
    });
    return res.data;
  }

  /** Bills are settled by recording an outgoing payment; there is no status flip. */
  async recordBillPayment(
    id: string,
    options?: { amount?: number | string; date?: string; paymentMethod?: string },
  ): Promise<Payment> {
    const bill = await this.getBill(id);
    if (!bill.contactId) {
      throw new Error('Bill has no contact — a contact is required to record a payment.');
    }
    const amount = options?.amount ?? bill.balanceDue ?? bill.total ?? '0';
    const res = await client.post<DataEnvelope<Payment>>('/payments', {
      type: 'sent',
      amount: String(amount),
      date: options?.date ?? new Date().toISOString(),
      billId: id,
      contactId: bill.contactId,
      paymentMethod: options?.paymentMethod ?? 'manual',
    });
    return res.data;
  }

  async deleteBill(id: string): Promise<void> {
    await client.delete(`/bills/${id}`);
  }

  // ========== Quick Expense ==========

  /** Quick expenses are one-line bills on app-api (no dedicated endpoint). */
  async createQuickExpense(data: {
    amount: number;
    category: string;
    description?: string;
    vendorName?: string;
    date?: string;
    documentId?: string;
    accountId?: string;
    taxRate?: number;
  }): Promise<Bill> {
    const expenseDate = data.date || new Date().toISOString().split('T')[0];
    return this.createBill({
      contactName: data.vendorName || 'Quick Expense',
      issueDate: expenseDate,
      dueDate: expenseDate,
      notes: data.description,
      documentId: data.documentId,
      items: [
        {
          description: data.description || data.category,
          quantity: 1,
          unitPrice: data.amount,
          taxRate: data.taxRate ?? 0,
          accountId: data.accountId,
        },
      ],
    });
  }

  // ========== Documents ==========
  // Scan flow: upload the image → `POST /accounting-documents/:id/process`
  // (vision OCR) → `POST /bills/from-document/:id` for the bill/expense prefill.

  /**
   * Uploads a local file to R2 through app-api's three-step broker:
   * `generate-upload-url` → `PUT` the bytes → `confirm-upload`. Returns the
   * `fileKey` to attach to a document record.
   */
  async uploadFile(localUri: string, fileName: string, mimeType = 'image/jpeg'): Promise<string> {
    const fileRes = await fetch(localUri);
    if (!fileRes.ok) throw new Error('Could not read the photo');
    const bytes = await fileRes.arrayBuffer();
    if (bytes.byteLength === 0) throw new Error('The photo file is empty');

    const ticket = await client.post<{
      success: boolean;
      uploadUrl: string;
      uploadToken: string;
      fileKey: string;
    }>('/storage/generate-upload-url', {
      fileName,
      contentType: mimeType,
      fileSize: bytes.byteLength,
      folder: 'accounting-documents',
      entityType: 'accounting-document',
    });
    if (!ticket?.uploadUrl || !ticket?.fileKey) {
      throw new Error('Upload URL unavailable');
    }

    // The upload URL is token-authenticated and takes no Clerk header.
    // Send the ArrayBuffer — React Native Blobs often report size 0 and PUT empty.
    const upload = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: bytes,
    });
    if (!upload.ok) throw new Error(`Upload failed (${upload.status})`);

    await client.post('/storage/confirm-upload', {
      uploadToken: ticket.uploadToken,
      fileKey: ticket.fileKey,
    });

    return ticket.fileKey;
  }

  async createDocument(data: {
    type?: string;
    fileName: string;
    fileKey?: string;
    mimeType?: string;
  }): Promise<{ id: string }> {
    const res = await client.post<DataEnvelope<{ id: string }>>('/accounting-documents', {
      type: data.type || 'receipt',
      fileName: data.fileName,
      originalFileName: data.fileName,
      fileKey: data.fileKey || data.fileName,
      mimeType: data.mimeType || 'image/jpeg',
      source: 'scan',
    });
    return res.data;
  }

  /** Capture a scanned receipt: upload the image, then register the document. */
  async uploadScannedDocument(localUri: string, fileName: string): Promise<{ id: string }> {
    const fileKey = await this.uploadFile(localUri, fileName);
    return this.createDocument({ type: 'receipt', fileName, fileKey });
  }

  /** Run vision OCR on an uploaded document. Throws if credits/gateway fail. */
  async processDocument(id: string): Promise<{ id: string; status: string; matchedContactId: string | null }> {
    const res = await client.post<DataEnvelope<{ id: string; status: string; matchedContactId: string | null }>>(
      `/accounting-documents/${id}/process`,
    );
    return res.data;
  }

  /** Bill-form prefill from a processed OCR document. */
  async getBillFromDocument(id: string): Promise<BillPrefill> {
    const res = await client.post<DataEnvelope<Json>>(`/bills/from-document/${id}`);
    return toBillPrefill(res.data ?? {});
  }

  // ========== Bank Accounts ==========

  async getBankAccounts(): Promise<BankAccount[]> {
    const res = await client.get<DataEnvelope<Json[]>>('/bank-accounts');
    return (res.data ?? []).map(toBankAccount);
  }

  async getBankAccount(id: string): Promise<BankAccountDetail> {
    const [accountRes, txRes] = await Promise.all([
      client.get<DataEnvelope<Json>>(`/bank-accounts/${id}`),
      client.get<ListEnvelope<Json>>(
        `/bank-transactions?${qs({ bankAccountId: id, page: 1, pageSize: 50 })}`,
      ),
    ]);
    return {
      ...toBankAccount(accountRes.data ?? {}),
      transactions: (txRes.data ?? []).map(toBankTransaction),
    };
  }

  // ========== Transactions ==========

  async getTransactions(params?: {
    page?: number;
    limit?: number;
    bankAccountId?: string;
    status?: string;
    fromDate?: string;
    toDate?: string;
  }): Promise<Paged<BankTransaction>> {
    const res = await client.get<ListEnvelope<Json>>(
      `/bank-transactions?${qs({
        page: params?.page ?? 1,
        pageSize: params?.limit ?? 50,
        bankAccountId: params?.bankAccountId,
        status: params?.status,
        from: params?.fromDate,
        to: params?.toDate,
      })}`,
    );
    return { ...page(res), items: (res.data ?? []).map(toBankTransaction) };
  }

  // ========== Reconciliation ==========

  async getReconciliationStats(): Promise<{
    totalUnmatched: number;
    totalMatched: number;
    pendingAmount: number;
    currency: string;
  }> {
    const [unmatched, matched] = await Promise.all([
      client.get<ListEnvelope<Json>>(
        `/bank-transactions?${qs({ status: 'unreconciled', page: 1, pageSize: 100 })}`,
      ),
      client.get<ListEnvelope<Json>>(
        `/bank-transactions?${qs({ status: 'reconciled', page: 1, pageSize: 1 })}`,
      ),
    ]);
    const pendingAmount = (unmatched.data ?? []).reduce(
      (sum, t) => sum + Math.abs(num(t.amount)),
      0,
    );
    return {
      totalUnmatched: unmatched.pagination?.totalCount ?? unmatched.data.length,
      totalMatched: matched.pagination?.totalCount ?? 0,
      pendingAmount,
      currency: 'EUR',
    };
  }

  /**
   * Unmatched transactions with `suggestedMatches` inlined from
   * `/bank-transactions/:id/suggestions` (one request per row, failures degrade
   * to an empty suggestion list rather than failing the screen).
   */
  async getUnmatchedTransactions(params?: {
    page?: number;
    limit?: number;
    bankAccountId?: string;
  }): Promise<UnmatchedTransaction[]> {
    const res = await client.get<ListEnvelope<Json>>(
      `/bank-transactions?${qs({
        status: 'unreconciled',
        page: params?.page ?? 1,
        pageSize: params?.limit ?? 20,
        bankAccountId: params?.bankAccountId,
      })}`,
    );
    const rows = res.data ?? [];

    const suggestionsPerRow = await Promise.all(
      rows.map((row) => this.getSuggestions(str(row.id))),
    );

    return rows.map((row, i) => ({
      ...toBankTransaction(row),
      suggestedMatches: suggestionsPerRow[i],
    }));
  }

  private async getSuggestions(transactionId: string): Promise<MatchSuggestion[]> {
    try {
      const res = await client.get<DataEnvelope<Json[]>>(
        `/bank-transactions/${transactionId}/suggestions`,
      );
      return (res.data ?? []).map((s) => {
        const type = str(s.type) === 'invoice' ? 'invoice' : 'bill';
        const number = s.number ? str(s.number) : undefined;
        const contactName = s.contactName ? str(s.contactName) : undefined;
        return {
          id: str(s.id),
          type,
          number,
          contactName,
          description: [type === 'invoice' ? 'Invoice' : 'Bill', number, contactName]
            .filter(Boolean)
            .join(' · '),
          amount: num(s.amount),
          confidence: num(s.confidence),
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Reconciles a transaction. Accepts a suggestion id (the reconciliation
   * screen's case — its type is looked up) or an explicit invoice/bill id.
   */
  async matchTransaction(
    transactionId: string,
    match: { invoiceId?: string; billId?: string } | string,
  ): Promise<void> {
    let type: 'invoice' | 'bill' | 'manual' = 'manual';
    let entityId: string | undefined;

    if (typeof match === 'string') {
      entityId = match;
      const found = (await this.getSuggestions(transactionId)).find((s) => s.id === match);
      if (found) type = found.type;
    } else if (match?.invoiceId) {
      type = 'invoice';
      entityId = match.invoiceId;
    } else if (match?.billId) {
      type = 'bill';
      entityId = match.billId;
    }

    await client.post(`/bank-transactions/${transactionId}/reconcile`, {
      type,
      ...(entityId ? { entityId } : {}),
    });
  }

  // ========== VAT Returns ==========

  /** Maps a vat_returns row to the fields the VAT screens read. */
  private mapVatReturn(row: Json): VatReturnDetail {
    const start = row.periodStart ? new Date(String(row.periodStart)) : null;
    const rubrieken = (row.rubrieken ?? {}) as Json;
    const salesTax = num(rubrieken.r5a);
    const purchaseTax = num(rubrieken.r5b);
    // app-api calls a filed return `filed`; the screens use `submitted`.
    const status = row.status === 'filed' ? 'submitted' : str(row.status, 'draft');
    return {
      id: str(row.id),
      period:
        (row.periodLabel as string | null) ??
        (start ? `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}` : ''),
      year: start ? start.getFullYear() : 0,
      status: status as VatReturnDetail['status'],
      salesTax,
      purchaseTax,
      netAmount: rubrieken.r5c != null ? num(rubrieken.r5c) : salesTax - purchaseTax,
      currency: 'EUR',
      periodStart: row.periodStart ? str(row.periodStart) : undefined,
      periodEnd: row.periodEnd ? str(row.periodEnd) : undefined,
      filedAt: row.filedAt ? str(row.filedAt) : null,
      dueDate: row.dueDate ? str(row.dueDate) : null,
      rubrieken,
    };
  }

  async getVatReturns(params?: { year?: number; status?: string }): Promise<VatReturn[]> {
    const res = await client.get<DataEnvelope<Json[]>>('/vat-returns');
    let returns = (res.data ?? []).map((r) => this.mapVatReturn(r));
    // app-api's list takes no filters — filter client-side like the old worker did.
    if (params?.year) returns = returns.filter((r) => r.year === params.year);
    if (params?.status) returns = returns.filter((r) => r.status === params.status);
    return returns;
  }

  async getVatReturn(id: string): Promise<VatReturnDetail> {
    const res = await client.get<DataEnvelope<Json>>(`/vat-returns/${id}`);
    return this.mapVatReturn(res.data ?? {});
  }

  /** Files the return (SBR/XBRL via Digipoort on app-api — not just a status flip). */
  async submitVatReturn(id: string): Promise<void> {
    await client.post(`/vat-returns/${id}/file`, {});
  }

  // ========== Reports ==========

  async getProfitLoss(fromDate: string, toDate: string): Promise<ProfitLossData> {
    const res = await client.get<DataEnvelope<Json>>(
      `/accounting-reports/profit-loss?${qs({ from: fromDate, to: toDate })}`,
    );
    const revenue = num(res.data.totalRevenue);
    const expenses = num(res.data.totalExpenses);
    const netProfit = num(res.data.netProfit);
    return {
      period: res.data.period,
      revenue,
      expenses,
      netProfit,
      profitMargin: revenue > 0 ? (netProfit / revenue) * 100 : 0,
      currency: 'EUR',
    };
  }

  async getBalanceSheet(): Promise<BalanceSheetData> {
    const res = await client.get<DataEnvelope<Json>>('/accounting-reports/balance-sheet');
    const section = (label: string, rows: unknown, total: unknown) => ({
      label,
      accounts: ((rows ?? []) as Json[]).map((r) => ({
        code: str(r.accountCode),
        name: str(r.accountName),
        balance: num(r.balance),
      })),
      total: num(total),
    });
    return {
      assets: section('Assets', res.data.assets, res.data.totalAssets),
      liabilities: section('Liabilities', res.data.liabilities, res.data.totalLiabilities),
      equity: section('Equity', res.data.equity, res.data.totalEquity),
      totalAssets: num(res.data.totalAssets),
      totalLiabilitiesAndEquity: num(res.data.totalLiabilitiesAndEquity),
      currency: 'EUR',
    };
  }

  // ========== Contacts ==========

  async getContacts(params?: {
    page?: number;
    limit?: number;
    search?: string;
    type?: string;
  }): Promise<Contact[]> {
    // Legacy "vendor" naming → app-api accounting role "supplier".
    const role =
      params?.type === 'vendor' ? 'supplier' : params?.type === 'customer' ? 'customer' : undefined;

    const res = await client.get<ListEnvelope<Json>>(
      `/accounting-contacts?${qs({
        page: params?.page ?? 1,
        pageSize: params?.limit ?? 100,
        search: params?.search,
        role,
      })}`,
    );
    return (res.data ?? []).map(toContact);
  }

  async getContact(id: string): Promise<Contact> {
    const res = await client.get<DataEnvelope<Json>>(`/accounting-contacts/${id}`);
    return toContact(res.data ?? {});
  }

  async getContactBalance(id: string): Promise<ContactBalance> {
    const res = await client.get<DataEnvelope<Json>>(`/accounting-contacts/${id}/balance`);
    const row = res.data ?? {};
    return {
      receivable: num(row.receivable ?? row.receivableBalance),
      payable: num(row.payable ?? row.payableBalance),
      currency: str(row.currency, 'EUR'),
    };
  }

  async getContactInvoices(id: string): Promise<Invoice[]> {
    const res = await client.get<ListEnvelope<Invoice>>(`/accounting-contacts/${id}/invoices`);
    return res.data ?? [];
  }

  async getContactBills(id: string): Promise<Bill[]> {
    const res = await client.get<ListEnvelope<Bill>>(`/accounting-contacts/${id}/bills`);
    return res.data ?? [];
  }

  async createContact(data: {
    fullName: string;
    email?: string;
    phone?: string;
    vatNumber?: string;
    role?: string;
  }): Promise<Contact> {
    const res = await client.post<DataEnvelope<Json>>('/accounting-contacts', {
      fullName: data.fullName,
      ...(data.email ? { email: data.email } : {}),
      ...(data.phone ? { phone: data.phone } : {}),
      ...(data.vatNumber ? { vatNumber: data.vatNumber } : {}),
      ...(data.role ? { role: data.role } : {}),
    });
    return toContact(res.data ?? {});
  }

  async deleteContact(id: string): Promise<void> {
    await client.delete(`/accounting-contacts/${id}`);
  }

  /**
   * Find an accounting contact by display name, or create one. app-api
   * invoices/bills require a contactId while the quick forms only collect a
   * free-text name — this bridges the two.
   */
  private async resolveContactId(name: string, email?: string): Promise<string> {
    const wanted = name.trim();
    try {
      const res = await client.get<ListEnvelope<Json>>(
        `/accounting-contacts?${qs({ search: wanted, page: 1, pageSize: 25 })}`,
      );
      const existing = (res.data ?? []).find(
        (row) => str(row.displayName).toLowerCase() === wanted.toLowerCase(),
      );
      if (existing?.id) return str(existing.id);
    } catch {
      // fall through to create
    }

    const created = await this.createContact({ fullName: wanted, email });
    return created.id;
  }

  // ========== Chart of Accounts / tax rates ==========

  async getAccounts(): Promise<GlAccount[]> {
    const res = await client.get<DataEnvelope<GlAccount[]>>('/gl-accounts');
    return res.data ?? [];
  }

  async getTaxRates(): Promise<TaxRate[]> {
    const res = await client.get<DataEnvelope<TaxRate[]>>('/tax-rates');
    return res.data ?? [];
  }

  // ========== Settings ==========

  async getSettings(): Promise<AppSettings> {
    const res = await client.get<DataEnvelope<Json>>('/accounting-settings');
    const row = res.data ?? {};
    return {
      currency: str(row.baseCurrency ?? row.currency, 'EUR'),
      fiscalYearStart: str(row.fiscalYearStart, '1 January'),
      entityName: row.entityName ? str(row.entityName) : undefined,
      jurisdictionCode: row.jurisdictionCode ? str(row.jurisdictionCode) : undefined,
      vatNumber: row.vatNumber ? str(row.vatNumber) : undefined,
    };
  }

  /**
   * Language (and other appearance prefs) from the signed-in user's profile.
   * Same row the platform Settings → Appearance picker writes.
   */
  async getUserPreferences(): Promise<UserPreferences> {
    const res = await client.get<DataEnvelope<Json>>('/user-preferences');
    const row = res.data ?? {};
    return {
      language: str(row.language, 'en'),
      theme: row.theme ? str(row.theme) : undefined,
      dateFormat: row.dateFormat ? str(row.dateFormat) : undefined,
      timeFormat: row.timeFormat ? str(row.timeFormat) : undefined,
      timezone: row.timezone ? str(row.timezone) : undefined,
    };
  }

  // ========== Search ==========

  /** Cross-entity search composed from the three list endpoints. */
  async search(query: string, limit = 15): Promise<SearchResult[]> {
    const params = (extra: Record<string, string | number>) => qs({ search: query, ...extra });
    const [invoices, bills, contacts] = await Promise.all([
      client.get<ListEnvelope<Json>>(`/invoices?${params({ page: 1, pageSize: 5 })}`),
      client.get<ListEnvelope<Json>>(`/bills?${params({ page: 1, pageSize: 5 })}`),
      client.get<ListEnvelope<Json>>(`/accounting-contacts?${params({ page: 1, pageSize: 5 })}`),
    ]);

    const build = (rows: Json[], type: SearchResultType, title: string, sub: string[]) =>
      rows.map((row) => ({
        id: str(row.id),
        title: str(row[title]),
        description: sub.map((k) => str(row[k])).filter(Boolean).join(' · '),
        type,
      }));

    return [
      ...build(invoices.data ?? [], 'invoice', 'invoiceNumber', ['contactName', 'status']),
      ...build(bills.data ?? [], 'bill', 'billNumber', ['contactName', 'status']),
      ...build(contacts.data ?? [], 'contact', 'displayName', ['email', 'role']),
    ].slice(0, limit);
  }

  // ========== Offline Queue ==========

  /**
   * app-api has no bulk offline-queue endpoint — replay the queued items one by
   * one against the regular routes, returning the per-item outcome so the
   * OfflineQueueContext can keep the failures queued.
   */
  async uploadOfflineQueue(
    items: { type: string; data: Json; entityId?: string }[],
  ): Promise<{ index: number; type: string; id?: string; error?: string }[]> {
    const results: { index: number; type: string; id?: string; error?: string }[] = [];
    const previousEntityId = accountingEntityId;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      accountingEntityId = item.entityId ?? previousEntityId;
      try {
        if (item.type === 'document') {
          const doc = await this.createDocument({
            type: str(item.data.type, 'receipt'),
            fileName: str(item.data.fileName, 'offline-scan'),
            fileKey: item.data.fileKey ? str(item.data.fileKey) : undefined,
            mimeType: item.data.mimeType ? str(item.data.mimeType) : undefined,
          });
          results.push({ index: i, type: 'document', id: doc.id });
        } else if (item.type === 'expense') {
          const bill = await this.createQuickExpense({
            amount: num(item.data.amount),
            category: str(item.data.category, 'Expense'),
            description: item.data.description as string | undefined,
            vendorName: item.data.vendorName as string | undefined,
            date: item.data.date as string | undefined,
            documentId: item.data.documentId as string | undefined,
            taxRate: num(item.data.taxRate),
          });
          results.push({ index: i, type: 'expense', id: bill.id });
        } else {
          results.push({ index: i, type: item.type, error: 'Unknown item type' });
        }
      } catch (err) {
        results.push({
          index: i,
          type: item.type,
          error: err instanceof Error ? err.message : 'Failed to process',
        });
      }
    }

    accountingEntityId = previousEntityId;
    return results;
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toBankAccount(row: Json): BankAccount {
  return {
    id: str(row.id),
    name: str(row.name),
    iban: row.iban ? str(row.iban) : undefined,
    bankName: row.bankName ? str(row.bankName) : undefined,
    accountType: str(row.accountType, 'checking'),
    currency: str(row.currency, 'EUR'),
    currentBalance: str(row.currentBalance, '0'),
    balance: num(row.currentBalance),
    isActive: row.isActive !== false,
    lastImportDate: row.lastImportDate ? str(row.lastImportDate) : null,
  };
}

function toBankTransaction(row: Json): BankTransaction {
  return {
    id: str(row.id),
    bankAccountId: str(row.bankAccountId),
    date: str(row.date ?? row.transactionDate),
    description: str(row.description),
    amount: num(row.amount),
    currency: str(row.currency, 'EUR'),
    status: str(row.status, 'unreconciled') as BankTransaction['status'],
    counterpartyName: row.counterpartyName ? str(row.counterpartyName) : undefined,
    reference: row.reference ? str(row.reference) : undefined,
    runningBalance: row.runningBalance != null ? num(row.runningBalance) : undefined,
  };
}

function toContact(row: Json): Contact {
  return {
    id: str(row.id),
    name: str(row.displayName ?? row.name),
    email: str(row.email),
    type: str(row.role, 'customer') as Contact['type'],
    phone: row.phone ? str(row.phone) : undefined,
    vatNumber: row.vatNumber ? str(row.vatNumber) : undefined,
    city: row.city ? str(row.city) : undefined,
    country: row.country ? str(row.country) : undefined,
  };
}

const api = new WeldBooksApi();
export default api;

/** Raw app-api client for surfaces this service doesn't wrap yet. */
export { client as appApiClient };
