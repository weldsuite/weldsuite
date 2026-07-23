/**
 * app-api client for WeldBooks mobile.
 *
 * Talks to the unified app-api (`/api/*`, apps/workers/app-api) — this app previously
 * hit the retired mobile-api-worker `/v2/weldbooks/*` surface. Built on
 * `createClientApi` from `@weldsuite/api-client` (throws on non-2xx; app-api
 * envelopes are `{ data }` for single items and `{ data, pagination }` for
 * lists).
 *
 * The public method surface is kept identical to the legacy service so
 * screens don't change: token wiring still goes through `setAccessToken` /
 * `setOrganizationId` / `setTokenRefreshCallback` (app/_layout.tsx), and each
 * method adapts the app-api response back to the shape its call sites read.
 *
 * Server-side model differences handled inside this layer:
 *  - Invoices/bills on app-api REQUIRE a `contactId`; the mobile forms only
 *    collect a free-text contact/vendor name. `resolveContactId()` finds an
 *    accounting contact by display name or creates one on the fly.
 *  - Line-item numbers (quantity/unitPrice/taxRate) are strings on app-api.
 *  - Invoice status flips map to dedicated endpoints (`PATCH /:id/send`,
 *    `PATCH /:id/status`, `POST /:id/record-payment`); bill actions map to
 *    `PATCH /:id/approve`, `PATCH /:id/reject`, and `POST /api/payments`.
 *    Setting an invoice to "overdue" is no longer possible — app-api computes
 *    overdue from `dueDate` + `balanceDue`.
 *  - "Quick expenses" and offline-queue items become regular bills/documents
 *    (`POST /api/bills`, `POST /api/accounting-documents`) — the worker's
 *    bulk `/offline-queue` endpoint has no app-api equivalent.
 */

import { createClientApi } from '@weldsuite/api-client/client';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import type {
  ApiResponse,
  Workspace,
  WorkspaceWithMembership,
  InstalledApp,
} from '@weldsuite/mobile-ui/types';

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

// ---------------------------------------------------------------------------
// Token wiring (kept from the legacy service so app/_layout.tsx is unchanged)
// ---------------------------------------------------------------------------

let accessToken: string | null = null;
let organizationId: string | null = null;
let tokenRefreshCallback: (() => Promise<string | null>) | null = null;

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

  // ========== Dashboard ==========

  /**
   * Composes the legacy `/weldbooks/dashboard` payload from
   * `/api/accounting-dashboard` + `/api/invoices` (recent list and per-status
   * counts, which the app-api dashboard doesn't break out).
   */
  async getDashboard(): Promise<ApiResponse<Json>> {
    const [dashboard, recent, sent, paid] = await Promise.all([
      client.get<DataEnvelope>('/accounting-dashboard'),
      client.get<ListEnvelope>('/invoices?page=1&pageSize=5'),
      client.get<ListEnvelope>('/invoices?status=sent&page=1&pageSize=1'),
      client.get<ListEnvelope>('/invoices?status=paid&page=1&pageSize=1'),
    ]);

    const d = dashboard.data;
    const revenue = (d.revenue ?? {}) as Json;
    const receivables = (d.receivables ?? {}) as Json;
    const payables = (d.payables ?? {}) as Json;

    return {
      success: true,
      data: {
        invoices: {
          sent: sent.pagination?.totalCount ?? 0,
          paid: paid.pagination?.totalCount ?? 0,
          overdue: num(receivables.overdueCount),
          totalOutstanding: String(receivables.outstanding ?? '0'),
          revenueMonth: String(revenue.month ?? '0'),
        },
        bills: {
          total: num(payables.outstandingCount),
          totalOutstanding: String(payables.outstanding ?? '0'),
        },
        bankAccounts: d.bankAccounts ?? [],
        recentInvoices: recent.data ?? [],
        pendingDocuments: num(d.pendingDocuments),
      },
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
  }): Promise<ApiResponse<Json>> {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 20;
    const searchParams = new URLSearchParams({ page: String(page), pageSize: String(limit) });
    if (params?.search) searchParams.set('search', params.search);
    if (params?.status) searchParams.set('status', params.status);
    if (params?.contactId) searchParams.set('contactId', params.contactId);
    if (params?.fromDate) searchParams.set('from', params.fromDate);
    if (params?.toDate) searchParams.set('to', params.toDate);

    const res = await client.get<ListEnvelope>(`/invoices?${searchParams.toString()}`);
    return {
      success: true,
      data: {
        items: res.data,
        meta: legacyMeta(page, limit, res.pagination?.totalCount ?? res.data.length),
      },
    };
  }

  async getInvoice(id: string): Promise<ApiResponse<Json>> {
    const res = await client.get<DataEnvelope>(`/invoices/${id}`);
    return { success: true, data: res.data };
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
    /** Accepted (legacy callers send it) but ignored — invoices start as drafts. */
    status?: string;
  }): Promise<ApiResponse<Json>> {
    const contactId =
      data.contactId ?? (await this.resolveContactId(data.contactName, data.contactEmail));

    const res = await client.post<DataEnvelope>('/invoices', {
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
    return { success: true, data: res.data };
  }

  async updateInvoice(
    id: string,
    data: Partial<{
      contactId: string;
      contactName: string;
      contactEmail: string;
      issueDate: string;
      dueDate: string;
      currency: string;
      notes: string;
      reference: string;
      items: LineItemInput[];
    }>,
  ): Promise<ApiResponse<Json>> {
    const body: Json = {};
    if (data.contactId !== undefined) body.contactId = data.contactId;
    if (data.contactName !== undefined) body.contactName = data.contactName;
    if (data.contactEmail !== undefined) body.contactEmail = data.contactEmail;
    if (data.issueDate !== undefined) body.issueDate = data.issueDate;
    if (data.dueDate !== undefined) body.dueDate = data.dueDate;
    if (data.currency !== undefined) body.currency = data.currency;
    if (data.notes !== undefined) body.notes = data.notes;
    if (data.reference !== undefined) body.reference = data.reference;
    if (data.items) body.items = toApiItems(data.items);

    const res = await client.put<DataEnvelope>(`/invoices/${id}`, body);
    return { success: true, data: res.data };
  }

  async updateInvoiceStatus(id: string, status: string): Promise<ApiResponse<Json>> {
    if (status === 'sent') {
      const res = await client.patch<DataEnvelope>(`/invoices/${id}/send`);
      return { success: true, data: res.data };
    }
    if (status === 'paid') {
      // app-api marks invoices paid by recording a payment for the open balance.
      const { data: invoice } = await client.get<DataEnvelope>(`/invoices/${id}`);
      const amount = String(invoice.balanceDue ?? invoice.total ?? '0');
      const res = await client.post<DataEnvelope>(`/invoices/${id}/record-payment`, {
        amount,
        date: new Date().toISOString(),
        paymentMethod: 'manual',
      });
      return { success: true, data: res.data };
    }
    if (status === 'cancelled' || status === 'uncollectible') {
      const res = await client.patch<DataEnvelope>(`/invoices/${id}/status`, { status });
      return { success: true, data: res.data };
    }
    // "overdue" (and anything else) is a computed state on app-api.
    throw new Error(
      `Invoice status "${status}" cannot be set manually — app-api derives it from the due date and balance.`,
    );
  }

  // ========== Bills ==========

  async getBills(params?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }): Promise<ApiResponse<Json>> {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 20;
    const searchParams = new URLSearchParams({ page: String(page), pageSize: String(limit) });
    if (params?.search) searchParams.set('search', params.search);
    if (params?.status) searchParams.set('status', params.status);

    const res = await client.get<ListEnvelope>(`/bills?${searchParams.toString()}`);
    return {
      success: true,
      // `bills` alias kept — the expenses screen reads `data.bills || data.data`.
      data: {
        items: res.data,
        bills: res.data,
        meta: legacyMeta(page, limit, res.pagination?.totalCount ?? res.data.length),
      },
    };
  }

  async getBill(id: string): Promise<ApiResponse<Json>> {
    const res = await client.get<DataEnvelope>(`/bills/${id}`);
    return { success: true, data: res.data };
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
    documentId?: string;
    items: LineItemInput[];
  }): Promise<ApiResponse<Json>> {
    const contactId = data.contactId ?? (await this.resolveContactId(data.contactName));

    const res = await client.post<DataEnvelope>('/bills', {
      contactId,
      contactName: data.contactName,
      ...(data.billNumber ? { billNumber: data.billNumber } : {}),
      issueDate: data.issueDate,
      dueDate: data.dueDate,
      ...(data.currency ? { currency: data.currency } : {}),
      ...(data.notes ? { notes: data.notes } : {}),
      ...(data.reference ? { reference: data.reference } : {}),
      ...(data.documentId ? { sourceDocumentId: data.documentId } : {}),
      items: toApiItems(data.items),
    });
    return { success: true, data: res.data };
  }

  /**
   * Field edits go to `PUT /api/bills/:id` (drafts only). The `{ status }`
   * shortcut the bill-detail screen sends maps to app-api's dedicated
   * approve / reject / payment endpoints.
   */
  async updateBill(
    id: string,
    data: Partial<{
      contactName: string;
      billNumber: string;
      issueDate: string;
      dueDate: string;
      notes: string;
      reference: string;
      status: string;
      reason: string;
    }>,
  ): Promise<ApiResponse<Json>> {
    if (data.status === 'approved') {
      const res = await client.patch<DataEnvelope>(`/bills/${id}/approve`);
      return { success: true, data: res.data };
    }
    if (data.status === 'rejected') {
      const res = await client.patch<DataEnvelope>(`/bills/${id}/reject`, {
        reason: data.reason || 'Rejected from the WeldBooks mobile app',
      });
      return { success: true, data: res.data };
    }
    if (data.status === 'paid') {
      // Bills are marked paid by recording an outgoing payment.
      const { data: bill } = await client.get<DataEnvelope>(`/bills/${id}`);
      if (!bill.contactId) {
        throw new Error('Bill has no contact — a contact is required to record a payment.');
      }
      const res = await client.post<DataEnvelope>('/payments', {
        type: 'sent',
        amount: String(bill.balanceDue ?? bill.total ?? '0'),
        date: new Date().toISOString(),
        billId: id,
        contactId: bill.contactId,
        paymentMethod: 'manual',
      });
      return { success: true, data: res.data };
    }

    const body: Json = {};
    if (data.contactName !== undefined) body.contactName = data.contactName;
    if (data.billNumber !== undefined) body.billNumber = data.billNumber;
    if (data.issueDate !== undefined) body.issueDate = data.issueDate;
    if (data.dueDate !== undefined) body.dueDate = data.dueDate;
    if (data.notes !== undefined) body.notes = data.notes;
    if (data.reference !== undefined) body.reference = data.reference;

    const res = await client.put<DataEnvelope>(`/bills/${id}`, body);
    return { success: true, data: res.data };
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
  }): Promise<ApiResponse<Json>> {
    const expenseDate = data.date || new Date().toISOString().split('T')[0];
    const res = await this.createBill({
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
    return {
      success: true,
      data: { ...(res.data ?? {}), category: data.category },
    };
  }

  // ========== Documents / Scanning ==========
  // OCR extraction lives at /api/accounting-documents/:id/process (metered AI
  // via /api/ai). The scan screen currently hands off to manual entry and
  // doesn't call it; wire it up there when the flow is re-enabled.

  // ========== Bank Accounts ==========

  /** Returns the accounts ARRAY — the bank screens consume it directly. */
  async getBankAccounts(): Promise<Json[]> {
    const res = await client.get<DataEnvelope<Json[]>>('/bank-accounts');
    return (res.data ?? []).map((account) => ({
      ...account,
      // Legacy fields the screens read.
      balance: num(account.currentBalance),
      lastSyncedAt: account.lastImportDate ?? null,
    }));
  }

  /** Returns the account object with its recent transactions inlined. */
  async getBankAccount(id: string): Promise<Json> {
    const [accountRes, txRes] = await Promise.all([
      client.get<DataEnvelope>(`/bank-accounts/${id}`),
      client.get<ListEnvelope>(`/bank-transactions?bankAccountId=${encodeURIComponent(id)}&page=1&pageSize=50`),
    ]);
    return {
      ...accountRes.data,
      balance: num(accountRes.data.currentBalance),
      transactions: (txRes.data ?? []).map((t) => ({
        ...t,
        amount: num(t.amount),
        runningBalance: num(t.runningBalance),
      })),
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
  }): Promise<ApiResponse<Json>> {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 50;
    const searchParams = new URLSearchParams({ page: String(page), pageSize: String(limit) });
    if (params?.bankAccountId) searchParams.set('bankAccountId', params.bankAccountId);
    if (params?.status) searchParams.set('status', params.status);
    if (params?.fromDate) searchParams.set('from', params.fromDate);
    if (params?.toDate) searchParams.set('to', params.toDate);

    const res = await client.get<ListEnvelope>(`/bank-transactions?${searchParams.toString()}`);
    return {
      success: true,
      data: {
        items: res.data,
        meta: legacyMeta(page, limit, res.pagination?.totalCount ?? res.data.length),
      },
    };
  }

  // ========== Reconciliation ==========

  /** Shape consumed directly by the reconciliation screen. */
  async getReconciliationStats(): Promise<Json> {
    const [unmatched, matched] = await Promise.all([
      client.get<ListEnvelope>('/bank-transactions?status=unreconciled&page=1&pageSize=100'),
      client.get<ListEnvelope>('/bank-transactions?status=reconciled&page=1&pageSize=1'),
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
   * Returns the unmatched-transactions ARRAY with `suggestedMatches` inlined
   * (fetched from /api/bank-transactions/:id/suggestions for the first rows).
   */
  async getUnmatchedTransactions(params?: {
    page?: number;
    limit?: number;
    bankAccountId?: string;
  }): Promise<Json[]> {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 20;
    const searchParams = new URLSearchParams({
      status: 'unreconciled',
      page: String(page),
      pageSize: String(limit),
    });
    if (params?.bankAccountId) searchParams.set('bankAccountId', params.bankAccountId);

    const res = await client.get<ListEnvelope>(`/bank-transactions?${searchParams.toString()}`);
    const rows = res.data ?? [];

    const suggestionsPerRow = await Promise.all(
      rows.map(async (row) => {
        try {
          const s = await client.get<DataEnvelope<Json[]>>(
            `/bank-transactions/${row.id}/suggestions`,
          );
          return s.data ?? [];
        } catch {
          return [];
        }
      }),
    );

    return rows.map((row, i) => ({
      ...row,
      amount: num(row.amount),
      currency: 'EUR',
      suggestedMatches: suggestionsPerRow[i].map((s) => ({
        id: String(s.id),
        type: String(s.type),
        description: [String(s.type) === 'invoice' ? 'Invoice' : 'Bill', s.number, s.contactName]
          .filter(Boolean)
          .join(' · '),
        amount: num(s.amount),
        confidence: num(s.confidence),
      })),
    }));
  }

  /**
   * Accepts either the legacy `{ invoiceId? | billId? }` object or a bare
   * suggestion id string (what the reconciliation screen passes).
   */
  async matchTransaction(
    transactionId: string,
    match: { invoiceId?: string; billId?: string } | string,
  ): Promise<ApiResponse<Json>> {
    let type: 'invoice' | 'bill' | 'manual' = 'manual';
    let entityId: string | undefined;

    if (typeof match === 'string') {
      entityId = match;
      try {
        const s = await client.get<DataEnvelope<Json[]>>(
          `/bank-transactions/${transactionId}/suggestions`,
        );
        const found = (s.data ?? []).find((sg) => String(sg.id) === match);
        const foundType = found ? String(found.type) : '';
        if (foundType === 'invoice' || foundType === 'bill') type = foundType;
      } catch {
        // fall through as manual reconciliation against the given id
      }
    } else if (match?.invoiceId) {
      type = 'invoice';
      entityId = match.invoiceId;
    } else if (match?.billId) {
      type = 'bill';
      entityId = match.billId;
    }

    const res = await client.post<DataEnvelope>(`/bank-transactions/${transactionId}/reconcile`, {
      type,
      ...(entityId ? { entityId } : {}),
    });
    return { success: true, data: { transactionId, ...res.data } };
  }

  // ========== VAT Returns ==========

  /** Maps a vat_returns row to the fields the VAT screens read. */
  private mapVatReturn(row: Json): Json {
    const start = row.periodStart ? new Date(String(row.periodStart)) : null;
    const rubrieken = (row.rubrieken ?? {}) as Json;
    const salesTax = num(rubrieken.r5a);
    const purchaseTax = num(rubrieken.r5b);
    const status = row.status === 'filed' ? 'submitted' : String(row.status ?? 'draft');
    return {
      ...row,
      period:
        (row.periodLabel as string | null) ??
        (start ? `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}` : ''),
      year: start ? start.getFullYear() : 0,
      status,
      salesTax,
      purchaseTax,
      netAmount: rubrieken.r5c != null ? num(rubrieken.r5c) : salesTax - purchaseTax,
      currency: 'EUR',
    };
  }

  /** Returns the VAT-returns ARRAY — the VAT screens consume it directly. */
  async getVatReturns(params?: { year?: number; status?: string }): Promise<Json[]> {
    const res = await client.get<DataEnvelope<Json[]>>('/vat-returns');
    let returns = (res.data ?? []).map((r) => this.mapVatReturn(r));
    // app-api's list takes no filters — filter client-side like the old worker did.
    if (params?.year) returns = returns.filter((r) => num(r.year) === params.year);
    if (params?.status) returns = returns.filter((r) => String(r.status) === params.status);
    return returns;
  }

  async getVatReturn(id: string): Promise<Json> {
    const res = await client.get<DataEnvelope>(`/vat-returns/${id}`);
    return this.mapVatReturn(res.data);
  }

  /** Files the return (SBR/XBRL via Digipoort on app-api — not just a status flip). */
  async submitVatReturn(id: string): Promise<ApiResponse<Json>> {
    const res = await client.post<DataEnvelope>(`/vat-returns/${id}/file`, {});
    return { success: true, data: res.data };
  }

  // ========== Reports ==========

  /** Shape consumed directly by the profit & loss screen. */
  async getProfitLoss(fromDate: string, toDate: string): Promise<Json> {
    const res = await client.get<DataEnvelope>(
      `/accounting-reports/profit-loss?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`,
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

  /** Shape consumed directly by the balance-sheet screen. */
  async getBalanceSheet(): Promise<Json> {
    const res = await client.get<DataEnvelope>('/accounting-reports/balance-sheet');
    const section = (label: string, rows: unknown, total: unknown) => ({
      label,
      accounts: ((rows ?? []) as Json[]).map((r) => ({
        code: String(r.accountCode ?? ''),
        name: String(r.accountName ?? ''),
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

  /** Returns the contacts ARRAY — the contacts screen consumes it directly. */
  async getContacts(params?: {
    page?: number;
    limit?: number;
    search?: string;
    type?: string;
  }): Promise<Json[]> {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 100;
    const searchParams = new URLSearchParams({ page: String(page), pageSize: String(limit) });
    if (params?.search) searchParams.set('search', params.search);
    // Legacy "vendor" naming → app-api accounting role "supplier".
    if (params?.type === 'customer' || params?.type === 'vendor') {
      searchParams.set('role', params.type === 'vendor' ? 'supplier' : 'customer');
    }

    const res = await client.get<ListEnvelope>(`/accounting-contacts?${searchParams.toString()}`);
    return (res.data ?? []).map((row) => ({
      ...row,
      name: String(row.displayName ?? row.name ?? ''),
      email: String(row.email ?? ''),
      type: String(row.role ?? 'customer'),
    }));
  }

  /**
   * Find an accounting contact by display name, or create one. app-api
   * invoices/bills require a contactId while the mobile forms only collect a
   * free-text name — this bridges the two.
   */
  private async resolveContactId(name: string, email?: string): Promise<string> {
    const wanted = name.trim();
    try {
      const res = await client.get<ListEnvelope>(
        `/accounting-contacts?search=${encodeURIComponent(wanted)}&page=1&pageSize=25`,
      );
      const existing = (res.data ?? []).find(
        (row) => String(row.displayName ?? '').toLowerCase() === wanted.toLowerCase(),
      );
      if (existing?.id) return String(existing.id);
    } catch {
      // fall through to create
    }

    const created = await client.post<DataEnvelope>('/accounting-contacts', {
      fullName: wanted,
      ...(email ? { email } : {}),
    });
    return String(created.data.id);
  }

  // ========== Chart of Accounts ==========

  async getAccounts(): Promise<ApiResponse<Json[]>> {
    const res = await client.get<DataEnvelope<Json[]>>('/gl-accounts');
    return { success: true, data: res.data ?? [] };
  }

  // ========== Tax Rates ==========

  async getTaxRates(): Promise<ApiResponse<Json[]>> {
    const res = await client.get<DataEnvelope<Json[]>>('/tax-rates');
    return { success: true, data: res.data ?? [] };
  }

  // ========== Settings ==========

  /** Shape consumed directly by the settings screen. */
  async getSettings(): Promise<Json> {
    const res = await client.get<DataEnvelope>('/accounting-settings');
    const row = res.data ?? {};
    return {
      ...row,
      currency: String(row.baseCurrency ?? row.currency ?? 'EUR'),
      fiscalYearStart: String(row.fiscalYearStart ?? '1 January'),
    };
  }

  // ========== Search ==========

  /** Cross-entity search composed from the three list endpoints. */
  async search(query: string, limit?: number): Promise<ApiResponse<Json[]>> {
    const max = limit ?? 15;
    const q = encodeURIComponent(query);
    const [invoices, bills, contacts] = await Promise.all([
      client.get<ListEnvelope>(`/invoices?search=${q}&page=1&pageSize=5`),
      client.get<ListEnvelope>(`/bills?search=${q}&page=1&pageSize=5`),
      client.get<ListEnvelope>(`/accounting-contacts?search=${q}&page=1&pageSize=5`),
    ]);

    const results: Json[] = [
      ...(invoices.data ?? []).map((i) => ({
        id: i.id,
        title: String(i.invoiceNumber ?? ''),
        description: `${i.contactName ?? ''} - ${i.status ?? ''}`,
        type: 'invoice',
      })),
      ...(bills.data ?? []).map((b) => ({
        id: b.id,
        title: String(b.billNumber ?? ''),
        description: `${b.contactName ?? ''} - ${b.status ?? ''}`,
        type: 'bill',
      })),
      ...(contacts.data ?? []).map((ct) => ({
        id: ct.id,
        title: String(ct.displayName ?? ''),
        description: String(ct.email ?? ct.role ?? ''),
        type: 'contact',
      })),
    ];

    return { success: true, data: results.slice(0, max) };
  }

  // ========== Offline Queue ==========

  /**
   * The worker's bulk `/weldbooks/offline-queue` endpoint has no app-api
   * equivalent — replay the queued items one by one against the regular
   * endpoints, preserving the `{ processed, results }` response the
   * OfflineQueueContext reads (failed indices stay queued).
   */
  async uploadOfflineQueue(
    items: Array<{ type: string; data: Json }>,
  ): Promise<ApiResponse<Json>> {
    const results: Array<{ index: number; type: string; id?: string; error?: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        if (item.type === 'document') {
          const res = await client.post<DataEnvelope>('/accounting-documents', {
            type: item.data.type || 'receipt',
            fileName: item.data.fileName || 'offline-scan',
            originalFileName: item.data.fileName || 'offline-scan',
            fileKey: item.data.fileKey || 'offline-scan',
            mimeType: item.data.mimeType || 'image/jpeg',
            source: 'scan',
          });
          results.push({ index: i, type: 'document', id: String(res.data.id) });
        } else if (item.type === 'expense') {
          const res = await this.createQuickExpense({
            amount: num(item.data.amount),
            category: String(item.data.category ?? 'Expense'),
            description: item.data.description as string | undefined,
            vendorName: item.data.vendorName as string | undefined,
            date: item.data.date as string | undefined,
            documentId: item.data.documentId as string | undefined,
            taxRate: num(item.data.taxRate),
          });
          results.push({ index: i, type: 'expense', id: String(res.data?.id) });
        } else {
          results.push({ index: i, type: item.type, error: 'Unknown item type' });
        }
      } catch {
        results.push({ index: i, type: item.type, error: 'Failed to process' });
      }
    }

    return { success: true, data: { processed: results.length, results } };
  }
}

const api = new WeldBooksApi();
export default api;

/** Raw app-api client for surfaces this service doesn't wrap yet. */
export { client as appApiClient };
