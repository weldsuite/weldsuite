/**
 * WeldBooks "send, quote and remind" client (phase 4a, Rust only: edition
 * features `books-invoice-email`, `books-quotes` and `books-reminders`):
 * e-mailing an invoice or a quote, revoking the public link, quotes and the
 * invoices made from them, the e-mail templates and the reminder workflow of
 * an entity, and reminders sent by hand or in bulk. Shapes mirror the handlers
 * in `rust/modules/books-sales/src/{delivery,quotes,reminders}*` and
 * `rust/modules/books/src/accounting_settings.rs`. Success answers `{ data }`.
 */
import { weldbooksApi } from '../weldbooks-client';
import type { Invoice } from './weldbooks';

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
// Sending
// ============================================================================

/** The body of `POST /invoices/:id/email` and `POST /accounting-quotes/:id/email`. */
export interface SendEmailInput {
  /** 1 to 10 addresses. */
  to: string[];
  cc?: string[];
  /** Left out, the entity's template applies. */
  subject?: string;
  body?: string;
  attachPdf?: boolean;
  includeLink?: boolean;
}

/** What the server sent: the link is null when the e-mail went without one. */
export interface EmailDelivery {
  messageId: string;
  to: string[];
  cc?: string[];
  subject: string;
  link: string | null;
}

export type SentInvoice = Invoice & { delivery: EmailDelivery };

export interface SentQuote {
  id: string;
  status: string;
  sentAt: string | null;
  delivery: EmailDelivery;
}

export interface LinkRevoked {
  id: string;
  linkRevoked: true;
}

/** One entry of an invoice's `emailHistory`. */
export type EmailHistoryType =
  | 'sent'
  | 'reminder'
  | 'viewed'
  | 'bounced'
  | 'link'
  | 'link_revoked'
  // Online payment (phase 4b): the customer started paying, the provider reported a status, a refund or chargeback.
  | 'payment_started'
  | 'payment_status'
  | 'payment_reversed';

/** What a final notice claims (`claim_json` of the reminder module); amounts are decimal text. */
export interface ReminderClaimParts {
  principal?: string | number;
  costs?: string | number;
  interest?: string | number;
  /** What the notice asks to be paid. */
  total?: string | number;
  /** The collection costs fall due with this notice. */
  costsDue?: boolean;
  /** This is the 14-day notice a consumer gets before costs fall due. */
  isNotice?: boolean;
}

export type ReminderClaim = string | number | ReminderClaimParts;

export interface EmailHistoryEntry {
  type: EmailHistoryType;
  at: string;
  to?: string | string[];
  level?: number;
  messageId?: string;
  /** The public link of a `link` entry. */
  link?: string;
  error?: string;
  claim?: ReminderClaim;
  /** `payment_started`. */
  molliePaymentId?: string;
  /** `payment_started` and `payment_reversed`: decimal text. */
  amount?: string | number;
  /** `payment_status`. */
  status?: 'paid' | 'failed' | 'expired' | 'canceled' | 'pending' | 'authorized';
  /** `payment_status`: the Mollie method id. */
  method?: string;
  /** `payment_reversed`. */
  kind?: 'refund' | 'chargeback';
}

// ============================================================================
// Quotes
// ============================================================================

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired', 'invoiced'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export interface QuoteRow {
  id: string;
  quoteNumber: string | null;
  name: string | null;
  contactId: string | null;
  contactName: string | null;
  total: string | null;
  currency: string | null;
  status: string;
  validUntil: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
  invoiceIds: string[];
  /** The invoices made from the quote (Rust only, `books-contact-page`): number and status for a chip. */
  invoices?: Array<{ id: string; invoiceNumber: string | null; status: string }>;
}

export interface QuoteLine {
  id?: string;
  description: string;
  quantity?: string | number | null;
  unitPrice: string | number;
  discountPercent?: string | number | null;
  taxRate?: string | number | null;
  unit?: string | null;
  taxRateId?: string | null;
  accountId?: string | null;
  productId?: string | null;
  lineTotal?: string | number | null;
}

export interface QuoteInvoiceRef {
  id: string;
  invoiceNumber: string | null;
  status: string;
  type: string;
  total: string | null;
  subtotal: string | null;
  currency: string | null;
  issueDate: string | null;
  entityId: string | null;
}

export interface QuoteDetail extends QuoteRow {
  subtotal: string | null;
  discount: string | null;
  tax: string | null;
  validFrom: string | null;
  paymentTerms: string | null;
  termsAndConditions: string | null;
  notes: string | null;
  signedBy: string | null;
  signedAt: string | null;
  opportunityId: string | null;
  createdAt: string;
  updatedAt: string;
  lines: QuoteLine[];
  invoices: QuoteInvoiceRef[];
}

export interface QuoteListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  contactId?: string;
}

export interface QuoteLineInput {
  description: string;
  quantity?: number;
  unitPrice: number;
  discountPercent?: number;
  taxRate?: number;
  unit?: string;
  taxRateId?: string;
  accountId?: string;
  productId?: string;
}

export interface QuoteInput {
  contactId: string;
  name: string;
  currency?: string;
  validFrom?: string;
  validUntil?: string;
  lines: QuoteLineInput[];
  notes?: string;
  paymentTerms?: string;
  termsAndConditions?: string;
  opportunityId?: string;
}

export interface InvoiceFromQuoteInput {
  /** The legal entity that invoices; left out, the selected one. */
  entityId?: string;
  /** 1 to 100: an advance invoice for that share. */
  percentage?: number;
}

export type InvoiceFromQuote = Invoice & { quoteId?: string; items?: unknown[] };

// ============================================================================
// Settings
// ============================================================================

export const EMAIL_TEMPLATE_KINDS = ['invoice', 'quote', 'reminder1', 'reminder2', 'reminder3', 'creditNote'] as const;
export type EmailTemplateKind = (typeof EMAIL_TEMPLATE_KINDS)[number];

export const EMAIL_TEMPLATE_LOCALES = ['nl', 'en'] as const;
export type EmailTemplateLocale = (typeof EMAIL_TEMPLATE_LOCALES)[number];

export interface EmailTemplate {
  subject: string;
  body: string;
  isDefault: boolean;
}

export interface EmailTemplatesSettings {
  entityId: string;
  kinds: string[];
  locales: string[];
  /** The placeholders a template may hold, such as `{{contact_name}}`. */
  placeholders: string[];
  templates: Partial<Record<string, Partial<Record<string, EmailTemplate>>>>;
}

/** `null` resets a template to the default. */
export type EmailTemplatesPatch = Partial<
  Record<string, Partial<Record<string, { subject: string; body: string } | null>>>
>;

export interface ReminderStep {
  level: number;
  daysAfterDue: number;
  /** Sent by the daily sweep; otherwise it is suggested in To process. */
  auto: boolean;
  /** The e-mail template of the step (`reminder1` to `reminder3`). */
  template: string;
  final: boolean;
}

export interface StatutoryCosts {
  enabled: boolean;
  interest: boolean;
  commercialRate: number;
  consumerRate: number;
}

export interface ReminderSettings {
  enabled: boolean;
  steps: ReminderStep[];
  statutoryCosts: StatutoryCosts;
  entityId: string;
  /** Only Dutch entities may claim the statutory collection costs (WIK). */
  statutoryAvailable: boolean;
  defaultRates?: { commercialRate: number; consumerRate: number };
}

export interface ReminderSettingsPatch {
  enabled?: boolean;
  steps?: ReminderStep[];
  statutoryCosts?: Partial<StatutoryCosts>;
}

// ============================================================================
// Reminders
// ============================================================================

export interface SentReminder {
  level: number;
  to: string | string[];
  messageId: string;
  subject: string;
  link: string | null;
  claim?: ReminderClaim;
}

export type RemindedInvoice = Invoice & { reminder: SentReminder };

export const REMIND_SKIP_REASONS = ['not_found', 'not_open', 'no_next_step', 'no_recipient', 'send_failed'] as const;
export type RemindSkipReason = (typeof REMIND_SKIP_REASONS)[number];

export interface BulkRemindResult {
  sent: Array<{
    invoiceIds: string[];
    level: number;
    to: string | string[];
    messageId: string;
    claim?: ReminderClaim;
  }>;
  skipped: Array<{ invoiceId: string; reason: string }>;
}

// ============================================================================
// API
// ============================================================================

export const salesApi = {
  emailInvoice: (id: string, input: SendEmailInput) =>
    weldbooksApi.post<DataEnvelope<SentInvoice>>(`/invoices/${encodeURIComponent(id)}/email`, input),
  revokeInvoiceLink: (id: string) =>
    weldbooksApi.delete<DataEnvelope<LinkRevoked>>(`/invoices/${encodeURIComponent(id)}/public-link`),
  remindInvoice: (id: string) =>
    weldbooksApi.post<DataEnvelope<RemindedInvoice>>(`/invoices/${encodeURIComponent(id)}/remind`, {}),
  remindBulk: (invoiceIds: string[]) =>
    weldbooksApi.post<DataEnvelope<BulkRemindResult>>('/invoices/remind-bulk', { invoiceIds }),
  setRemindersPaused: (id: string, paused: boolean) =>
    weldbooksApi.patch<DataEnvelope<Invoice>>(`/invoices/${encodeURIComponent(id)}/reminders`, { paused }),
  invoiceFromQuote: (quoteId: string, input: InvoiceFromQuoteInput) =>
    weldbooksApi.post<DataEnvelope<InvoiceFromQuote>>(`/invoices/from-quote/${encodeURIComponent(quoteId)}`, input),

  listQuotes: (params: QuoteListParams = {}) =>
    weldbooksApi.get<PagedEnvelope<QuoteRow>>(`/accounting-quotes${buildQuery({ ...params })}`),
  getQuote: (id: string) => weldbooksApi.get<DataEnvelope<QuoteDetail>>(`/accounting-quotes/${encodeURIComponent(id)}`),
  createQuote: (input: QuoteInput) => weldbooksApi.post<DataEnvelope<QuoteDetail>>('/accounting-quotes', input),
  updateQuote: (id: string, input: QuoteInput) =>
    weldbooksApi.put<DataEnvelope<QuoteDetail>>(`/accounting-quotes/${encodeURIComponent(id)}`, input),
  emailQuote: (id: string, input: SendEmailInput) =>
    weldbooksApi.post<DataEnvelope<SentQuote>>(`/accounting-quotes/${encodeURIComponent(id)}/email`, input),
  revokeQuoteLink: (id: string) =>
    weldbooksApi.delete<DataEnvelope<LinkRevoked>>(`/accounting-quotes/${encodeURIComponent(id)}/public-link`),

  getEmailTemplates: () => weldbooksApi.get<DataEnvelope<EmailTemplatesSettings>>('/accounting-settings/email-templates'),
  updateEmailTemplates: (templates: EmailTemplatesPatch) =>
    weldbooksApi.patch<DataEnvelope<EmailTemplatesSettings>>('/accounting-settings/email-templates', { templates }),
  getReminderSettings: () => weldbooksApi.get<DataEnvelope<ReminderSettings>>('/accounting-settings/reminders'),
  updateReminderSettings: (patch: ReminderSettingsPatch) =>
    weldbooksApi.patch<DataEnvelope<ReminderSettings>>('/accounting-settings/reminders', patch),
};
