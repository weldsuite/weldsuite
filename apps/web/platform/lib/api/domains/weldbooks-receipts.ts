/**
 * WeldBooks "inbox and receipts" and "pay bills" client (phase 3, Rust only:
 * edition features `books-receipts` and `books-sepa-batches`): the inbox
 * address of an entity, the paged inbox documents, booking a document as a
 * bill, receipt or credit note in one call, the bank lines that could have
 * paid it, duplicate checks, a supplier's usual category and VAT, and SEPA
 * credit-transfer batches. Shapes mirror the handlers in
 * `rust/modules/books-purchases/src/{document_booking,accounting_documents,
 * booking_defaults}.rs`, `payment_runs/sepa.rs` and
 * `rust/modules/books/src/accounting_entities/mod.rs`. Every answer is `{ data }`.
 */
import { weldbooksApi } from '../weldbooks-client';
import type { Document } from './weldbooks';

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
// Inbox per entity
// ============================================================================

export interface EntityInbox {
  entityId: string;
  email: string | null;
  workspaceAddress: boolean;
  autoScanEnabled: boolean;
}

// ============================================================================
// Documents
// ============================================================================

/** An inbox document as the list answers it (the fields the screens read). */
export interface InboxDocument extends Omit<Document, 'ocrResult'> {
  mimeType?: string | null;
  fileSize?: number | null;
  originalFileName?: string | null;
  ocrResult?: InboxOcrResult | null;
}

export interface InboxOcrResult {
  vendor?: {
    name: string | null;
    address: string | null;
    taxNumber: string | null;
    kvkNumber: string | null;
    iban: string | null;
    bic: string | null;
  } | null;
  total?: number | null;
  currency?: string | null;
  confidence?: { overall: number } | null;
}

export interface DocumentListParams {
  status?: string;
  page?: number;
  pageSize?: number;
}

export const BOOK_KINDS = ['purchase_invoice', 'receipt', 'credit_note'] as const;
export type BookKind = (typeof BOOK_KINDS)[number];

export const PAID_WITH_TYPES = ['bank_transaction', 'cash', 'private', 'card_unmatched'] as const;
export type PaidWithType = (typeof PAID_WITH_TYPES)[number];

export interface PaidWith {
  type: PaidWithType;
  bankTransactionId?: string;
}

export interface BookLineInput {
  description: string;
  /** Left out, the supplier's usual expense account is used. */
  accountId?: string;
  taxRateId?: string;
  /** Tax-inclusive; all lines add up to the document's total to the cent. */
  amount: number;
  projectId?: string;
}

export interface BookDocumentInput {
  kind: BookKind;
  contactId: string;
  invoiceNumber?: string;
  date: string;
  dueDate?: string;
  currency?: string;
  lines: BookLineInput[];
  paidWith?: PaidWith;
}

export interface BookedBill {
  id: string;
  billNumber?: string | null;
  status?: string;
  total?: string | null;
  currency?: string | null;
  [key: string]: unknown;
}

export interface BookedPayment {
  id: string;
  amount?: string;
  date?: string;
  [key: string]: unknown;
}

/** 201 for a new booking; 200 with `alreadyBooked` when the document was booked before. */
export interface BookDocumentResult {
  bill: BookedBill;
  payment?: BookedPayment | null;
  bankTransactionId?: string | null;
  autoLinked?: boolean;
  alreadyBooked?: boolean;
}

export interface BankCandidate {
  id: string;
  bankAccountId: string;
  date: string;
  /** Signed: money out is negative. */
  amount: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  description: string | null;
  reference: string | null;
  score: number;
  reasons: string[];
  /** Exact amount and one clear match: safe to preselect. */
  sure: boolean;
}

export interface BankCandidateOverrides {
  amount?: number | string;
  date?: string;
  contactId?: string;
  invoiceNumber?: string;
}

export interface DuplicateBill {
  id: string;
  billNumber: string | null;
  type: string;
  status: string;
  externalReference: string | null;
  contactId: string;
  contactName: string | null;
  issueDate: string;
  total: string | null;
  currency: string | null;
  reason: string;
}

export interface DuplicateDocument {
  id: string;
  fileName: string;
  originalFileName: string | null;
  status: string;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  createdAt: string;
  reason: string;
}

export interface DocumentDuplicates {
  bills: DuplicateBill[];
  documents: DuplicateDocument[];
}

export interface PrefillLine {
  description: string;
  /** Gross (tax-inclusive). */
  amount: number;
  taxRate: number | null;
  taxRateId: string | null;
  accountId: string | null;
  projectId: string | null;
}

export interface DocumentPrefill {
  sourceDocumentId: string;
  kind: BookKind;
  contactId: string | null;
  contactName: string | null;
  invoiceNumber: string | null;
  date: string | null;
  dueDate: string | null;
  currency: string | null;
  lines: PrefillLine[];
  subtotal: number | null;
  taxTotal: number | null;
  total: number | null;
  paid: boolean;
  paymentMethod: string | null;
  paidWith: { type: PaidWithType } | null;
  iban: string | null;
  paymentReference: string | null;
  /** The scan's confidence (`overall`, 0 to 1), when the document was scanned. */
  confidence: { overall?: number } | null;
  defaults: Record<string, unknown> | null;
}

export interface ContactBookingDefaults {
  contactId: string;
  basedOnBills: number;
  basedOnLines: number;
  account: { accountId: string; code: string; name: string; count: number; source: string } | null;
  taxRate: { taxRateId: string; name: string; rate: string | number; count: number; source: string } | null;
  project: { projectId: string; name?: string | null; count: number; source: string } | null;
  lastBill: unknown;
}

export const receiptsApi = {
  getInbox: (entityId: string) =>
    weldbooksApi.get<DataEnvelope<EntityInbox>>(`/accounting-entities/${encodeURIComponent(entityId)}/inbox`),
  setInbox: (entityId: string, email: string) =>
    weldbooksApi.post<DataEnvelope<EntityInbox>>(`/accounting-entities/${encodeURIComponent(entityId)}/inbox`, { email }),

  /** The entity's documents, a page at a time (without `scope=entity` the server answers the old first 100). */
  listDocuments: (params: DocumentListParams = {}) =>
    weldbooksApi.get<PagedEnvelope<InboxDocument>>(`/accounting-documents${buildQuery({ scope: 'entity', ...params })}`),
  getDocumentStats: () =>
    weldbooksApi.get<DataEnvelope<Array<{ status: string; count: number }>>>('/accounting-documents/stats?scope=entity'),
  getDocument: (id: string) => weldbooksApi.get<DataEnvelope<InboxDocument>>(`/accounting-documents/${encodeURIComponent(id)}`),
  getPrefill: (id: string) => weldbooksApi.get<DataEnvelope<DocumentPrefill>>(`/accounting-documents/${encodeURIComponent(id)}/prefill`),
  bookDocument: (id: string, input: BookDocumentInput) =>
    weldbooksApi.post<DataEnvelope<BookDocumentResult>>(`/accounting-documents/${encodeURIComponent(id)}/book`, input),
  getBankCandidates: (id: string, overrides: BankCandidateOverrides = {}) =>
    weldbooksApi.get<DataEnvelope<BankCandidate[]>>(
      `/accounting-documents/${encodeURIComponent(id)}/bank-candidates${buildQuery({ ...overrides })}`,
    ),
  getDuplicates: (id: string) =>
    weldbooksApi.get<DataEnvelope<DocumentDuplicates>>(`/accounting-documents/${encodeURIComponent(id)}/duplicates`),
  getBookingDefaults: (contactId: string) =>
    weldbooksApi.get<DataEnvelope<ContactBookingDefaults>>(`/accounting-contacts/${encodeURIComponent(contactId)}/booking-defaults`),
};

// ============================================================================
// SEPA batches (`/api/payment-batches`)
// ============================================================================

export const BATCH_ERROR_CODES = [
  'INVALID_DATE',
  'EXECUTION_DATE_PAST',
  'BANK_ACCOUNT_IBAN',
  'BANK_ACCOUNT_INACTIVE',
  'NOT_EUR',
  'DUPLICATE_BILL',
  'BILL_NOT_FOUND',
  'BILL_OTHER_ENTITY',
  'BILL_NOT_PAYABLE',
  'BILL_CURRENCY',
  'BILL_IN_OTHER_RUN',
  'NO_SUPPLIER',
  'NO_IBAN',
  'ALL_HELD',
] as const;
export type BatchErrorCode = (typeof BATCH_ERROR_CODES)[number];

export type BatchStatus = 'exported' | 'cancelled' | 'completed';

export interface BatchBill {
  billId: string;
  billNumber: string | null;
  externalReference: string | null;
  partyId: string | null;
  contactName: string | null;
  iban: string | null;
  amount: string;
  remittance: string | null;
  billStatus: string;
  balanceDue: string | null;
  paid: boolean;
}

export interface BatchHeld {
  partyId: string | null;
  contactName: string | null;
  code: string;
  message: string;
}

export interface PaymentBatch {
  id: string;
  status: string;
  bankAccountId: string;
  bankAccountName: string | null;
  executionDate: string;
  totalAmount: string;
  paymentCount: number;
  billCount: number;
  paidBillCount: number;
  heldCount: number;
  fileName: string | null;
  fileGeneratedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  bills: BatchBill[];
  held: BatchHeld[];
}

export interface CreateBatchInput {
  bankAccountId: string;
  billIds: string[];
  executionDate: string;
}

export interface PendingBill {
  billId: string;
  batchId: string;
  executionDate: string;
}

export interface BatchListParams {
  status?: string;
  page?: number;
  pageSize?: number;
}

export const batchesApi = {
  list: (params: BatchListParams = {}) =>
    weldbooksApi.get<PagedEnvelope<PaymentBatch>>(`/payment-batches${buildQuery({ ...params })}`),
  get: (id: string) => weldbooksApi.get<DataEnvelope<PaymentBatch>>(`/payment-batches/${encodeURIComponent(id)}`),
  create: (input: CreateBatchInput) => weldbooksApi.post<DataEnvelope<PaymentBatch>>('/payment-batches', input),
  /** The pain.001 XML, as text. */
  file: (id: string) => weldbooksApi.get<string>(`/payment-batches/${encodeURIComponent(id)}/file`),
  cancel: (id: string) => weldbooksApi.post<DataEnvelope<PaymentBatch>>(`/payment-batches/${encodeURIComponent(id)}/cancel`),
  pendingBills: () => weldbooksApi.get<DataEnvelope<PendingBill[]>>('/payment-batches/pending-bills'),
};
