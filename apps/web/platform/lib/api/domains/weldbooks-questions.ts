/**
 * WeldBooks "working with the accountant" client (phase 7, Rust only: edition
 * feature `books-questions`, ADR BOOKS-015): questions on records, the VAT
 * return's check, the suggested lock date and the accountant's review marks.
 * Shapes mirror `rust/modules/chat/src/groups/accounting_questions.rs`,
 * `rust/modules/books-tax/src/vat_checks.rs` and
 * `rust/modules/books/src/accounting_entities/lock_suggestion.rs`.
 */
import type {
  AskQuestionInput,
  AskQuestionsBulkInput,
  BooksRecordChatType,
  QuestionStatus,
} from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { weldbooksApi } from '../weldbooks-client';

export interface QuestionPerson {
  id: string;
  name: string | null;
}

/** One question: the first message of a thread in a record's chat. */
export interface Question {
  /** The thread's first message. */
  id: string;
  recordType: BooksRecordChatType;
  recordId: string;
  recordTitle: string | null;
  text: string;
  status: QuestionStatus;
  askedBy: QuestionPerson;
  askedTo: QuestionPerson[];
  createdAt: string;
  lastReplyAt: string | null;
  replyCount: number;
  entityId: string | null;
  channelId: string;
  /** The platform URL of the record (`/weldbooks/…?stack=…`, or the documents page). */
  link: string | null;
}

export interface AskedQuestion extends Question {
  /** The question created the record's chat. */
  createdChannel: boolean;
}

export interface QuestionListParams {
  status?: QuestionStatus;
  /** `me`: asked to the caller; `any`: every question the caller may see. */
  askedTo?: 'me' | 'any';
  recordType?: BooksRecordChatType;
  cursor?: string | null;
  limit?: number;
}

export interface QuestionPage {
  data: Question[];
  pagination: { totalCount: number; hasMore: boolean; cursor?: string | null };
}

export interface BulkAskResult {
  created: Question[];
  failed: Array<{ recordId: string; status: number; error: string }>;
}

/** One loose end of a VAT return's period. */
export interface VatCheck {
  count: number;
  /** Up to five ids to show as chips. */
  sampleIds: string[];
  amount?: string | null;
  currency?: string | null;
  mixedCurrency?: boolean;
  /** The caller may not see these records: the count is not shown. */
  restricted?: boolean;
}

export const VAT_CHECK_KEYS = [
  'unprocessed_bank_lines',
  'unbooked_documents',
  'missing_receipts',
  'possible_duplicates',
  'draft_invoices_in_period',
  'open_transfers',
] as const;
export type VatCheckKey = (typeof VAT_CHECK_KEYS)[number];

export type VatChecks = Record<VatCheckKey, VatCheck>;

export const LOCK_SUGGESTION_REASONS = [
  'oldest_unprocessed_bank_line',
  'oldest_unbooked_document',
  'oldest_draft_invoice',
  'oldest_draft_bill',
  'end_of_last_month',
] as const;
export type LockSuggestionReason = (typeof LOCK_SUGGESTION_REASONS)[number];

export interface LockDateSuggestion {
  suggestedDate: string;
  reason: LockSuggestionReason;
  blockingItem?: {
    kind: 'bank_line' | 'document' | 'draft_invoice' | 'draft_bill';
    /** The object panel's type. */
    objectType: string;
    objectId: string;
    date: string;
  };
}

export interface ReviewBulkResult {
  reviewed: string[];
  skipped: string[];
}

interface Envelope<T> {
  data: T;
}

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

export const questionsApi = {
  list: (params: QuestionListParams = {}) =>
    weldbooksApi.get<QuestionPage>(`/accounting-questions${buildQuery({ ...params })}`),
  ask: (input: AskQuestionInput) => weldbooksApi.post<Envelope<AskedQuestion>>('/accounting-questions', input),
  askMany: (input: AskQuestionsBulkInput) =>
    weldbooksApi.post<Envelope<BulkAskResult>>('/accounting-questions/bulk', input),
  setStatus: (messageId: string, status: QuestionStatus) =>
    weldbooksApi.patch<Envelope<Question>>(`/accounting-questions/${encodeURIComponent(messageId)}`, { status }),

  vatChecks: (vatReturnId: string) =>
    weldbooksApi.get<Envelope<VatChecks>>(`/vat-returns/${encodeURIComponent(vatReturnId)}/checks`),
  lockDateSuggestion: (entityId: string) =>
    weldbooksApi.get<Envelope<LockDateSuggestion>>(
      `/accounting-entities/${encodeURIComponent(entityId)}/lock-date-suggestion`,
    ),

  review: (journalEntryId: string) =>
    weldbooksApi.post<Envelope<unknown>>(`/journal-entries/${encodeURIComponent(journalEntryId)}/review`),
  unreview: (journalEntryId: string) =>
    weldbooksApi.delete<Envelope<unknown>>(`/journal-entries/${encodeURIComponent(journalEntryId)}/review`),
  reviewBulk: (ids: string[]) => weldbooksApi.post<Envelope<ReviewBulkResult>>('/journal-entries/review-bulk', { ids }),
};
