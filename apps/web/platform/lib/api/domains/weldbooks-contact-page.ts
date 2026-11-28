/**
 * WeldBooks contact page client (phase 5, Rust only: edition feature
 * `books-contact-page`): the timeline, the summary, the statement, the stored
 * defaults, the contact behind a WeldCRM record and the public links of a
 * document. Shapes mirror `rust/modules/books-purchases/src/accounting_contacts/page.rs`.
 * Every answer is `{ data }`.
 */
import { weldbooksApi, type BlobResult } from '../weldbooks-client';
import type { Customer } from './weldbooks';

export interface DataEnvelope<T> {
  data: T;
}

export interface PagedEnvelope<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor?: string | null };
}

function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

// ============================================================================
// Timeline
// ============================================================================

export const TIMELINE_TYPES = [
  'quote',
  'invoice',
  'credit_note',
  'bill',
  'receipt',
  'payment',
  'bank_line',
  'document',
  'email_sent',
  'email_viewed',
  'reminder',
  'email_bounced',
] as const;
export type TimelineType = (typeof TIMELINE_TYPES)[number];

/** What an item opens: `payment` has no panel and `document` opens the inbox. */
export type TimelineObjectType = 'quote' | 'invoice' | 'bill' | 'payment' | 'bank_transaction' | 'document';

export interface TimelineItem {
  type: TimelineType;
  objectType: TimelineObjectType;
  objectId: string;
  date: string;
  title: string | null;
  subtitle: string | null;
  amount: string | null;
  currency: string | null;
  status: string | null;
  /** `overdue`, `expired`, `in`, `out`, `received`, `paid`, `level:N`, or a document type. */
  hint: string | null;
}

// ============================================================================
// Summary
// ============================================================================

/** An amount per currency: a contact can owe or be owed in several. */
export interface CurrencySum {
  currency: string;
  amount: string;
  count?: number;
}

export interface ContactSummary {
  toReceive: CurrencySum[];
  overdue: CurrencySum[];
  toPay: CurrencySum[];
  unappliedCredit: CurrencySum[];
  openQuotes: { count: number; amount: CurrencySum[] };
  /** Only for a member who may read time. */
  unbilledHours?: { hours: string; amount: string; currency: string };
}

export interface ContactBySummary {
  contact: Customer;
  summary: ContactSummary;
}

// ============================================================================
// Statement
// ============================================================================

export interface StatementRow {
  kind: string;
  objectType: string;
  objectId: string;
  number: string | null;
  date: string;
  dueDate: string | null;
  currency: string;
  amount: string;
  balance: string;
  overdueDays: number;
}

export interface StatementTotal {
  currency: string;
  amount: string;
}

export interface StatementJson {
  contact: { id?: string; name?: string; displayName?: string; email?: string | null } & Record<string, unknown>;
  entityId: string;
  asOf: string;
  locale: string;
  rows: StatementRow[];
  totals: StatementTotal[];
}

// ============================================================================
// Defaults
// ============================================================================

export interface ContactDefaults {
  contactId: string;
  defaultExpenseAccountId: string | null;
  defaultTaxRateId: string | null;
  paymentTermsDays: number | null;
  /** For the selected legal entity. */
  remindersPaused: boolean;
}

/** `null` clears a value. */
export type ContactDefaultsPatch = Partial<Omit<ContactDefaults, 'contactId'>>;

export interface PagedParams {
  page: number;
  pageSize: number;
}

export interface PublicLink {
  url: string | null;
}

// ============================================================================
// API
// ============================================================================

export const contactPageApi = {
  timeline: (id: string, params: { cursor?: string | null; limit?: number } = {}) =>
    weldbooksApi.get<PagedEnvelope<TimelineItem>>(
      `/accounting-contacts/${encodeURIComponent(id)}/timeline${buildQuery({ cursor: params.cursor, limit: params.limit })}`,
    ),
  summary: (id: string) =>
    weldbooksApi.get<DataEnvelope<ContactSummary>>(`/accounting-contacts/${encodeURIComponent(id)}/summary`),
  statement: (id: string, asOf?: string) =>
    weldbooksApi.get<DataEnvelope<StatementJson>>(
      `/accounting-contacts/${encodeURIComponent(id)}/statement${buildQuery({ asOf, format: 'json' })}`,
    ),
  statementPdf: (id: string, asOf?: string): Promise<BlobResult> =>
    weldbooksApi.getBlob(
      `/accounting-contacts/${encodeURIComponent(id)}/statement${buildQuery({ asOf, format: 'pdf' })}`,
    ),
  defaults: (id: string) =>
    weldbooksApi.get<DataEnvelope<ContactDefaults>>(`/accounting-contacts/${encodeURIComponent(id)}/defaults`),
  updateDefaults: (id: string, patch: ContactDefaultsPatch) =>
    weldbooksApi.patch<DataEnvelope<ContactDefaults>>(`/accounting-contacts/${encodeURIComponent(id)}/defaults`, patch),
  byCrm: (target: { companyId: string } | { personId: string }) =>
    weldbooksApi.get<DataEnvelope<ContactBySummary | null>>(`/accounting-contacts/by-crm${buildQuery({ ...target })}`),
  invoicesPage: <T>(id: string, { page, pageSize }: PagedParams) =>
    weldbooksApi.get<PagedEnvelope<T>>(
      `/accounting-contacts/${encodeURIComponent(id)}/invoices${buildQuery({ page, pageSize })}`,
    ),
  billsPage: <T>(id: string, { page, pageSize }: PagedParams) =>
    weldbooksApi.get<PagedEnvelope<T>>(
      `/accounting-contacts/${encodeURIComponent(id)}/bills${buildQuery({ page, pageSize })}`,
    ),
  invoicePublicLink: (id: string) =>
    weldbooksApi.get<DataEnvelope<PublicLink>>(`/invoices/${encodeURIComponent(id)}/public-link`),
  quotePublicLink: (id: string) =>
    weldbooksApi.get<DataEnvelope<PublicLink>>(`/accounting-quotes/${encodeURIComponent(id)}/public-link`),
};
