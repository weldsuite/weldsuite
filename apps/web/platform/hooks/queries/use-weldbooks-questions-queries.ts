/**
 * Query hooks of "working with the accountant" (phase 7, edition feature
 * `books-questions`, Rust only): questions on records, the VAT return's check,
 * the suggested lock date and the review marks of automatic bookings.
 *
 * Every key sits under `['accounting', ...]`, so switching the accounting
 * entity resets them with the rest.
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AskQuestionInput,
  AskQuestionsBulkInput,
  QuestionStatus,
} from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import {
  questionsApi,
  type Question,
  type QuestionListParams,
  type QuestionPage,
} from '@/lib/api/domains/weldbooks-questions';
import { bankingApi } from '@/lib/api/domains/weldbooks-banking';
import { isFeatureAvailable } from '@/lib/edition';
import { updateMessageInCache, weldchatKeys } from './use-weldchat-queries';

/** Whether this deployment has questions to the accountant (the Rust backend only). */
export function isQuestionsAvailable(): boolean {
  return isFeatureAvailable('books-questions');
}

/** Questions load this many at a time. */
export const QUESTIONS_PAGE_SIZE = 25;

/**
 * The keys of the other accounting queries a question or a review mark changes. They are spelled out
 * instead of imported so that the record panels, which import this file, do not load the whole
 * accounting query layer; `use-weldbooks-questions-queries.test.ts` checks they match the real ones.
 */
const ACCOUNTING_ROOT = ['accounting'] as const;
export const SIBLING_KEYS = {
  todo: [...ACCOUNTING_ROOT, 'todo'] as const,
  journalEntries: [...ACCOUNTING_ROOT, 'journal-entries'] as const,
  bankTransactions: [...ACCOUNTING_ROOT, 'bank-transactions'] as const,
  /** `bankingKeys.lines.links(id)`. */
  bankLineLinks: (id: string) => [...ACCOUNTING_ROOT, 'bank-transactions', 'links', id] as const,
};

export const questionKeys = {
  all: [...ACCOUNTING_ROOT, 'questions'] as const,
  list: (filters: Omit<QuestionListParams, 'cursor' | 'limit'>) => [...questionKeys.all, 'list', filters] as const,
  vatChecks: (vatReturnId: string) => [...ACCOUNTING_ROOT, 'vat-checks', vatReturnId] as const,
  lockSuggestion: (entityId: string) => [...ACCOUNTING_ROOT, 'lock-suggestion', entityId] as const,
};

/** Everything a new or changed question touches: the lists, To process and the record's chat. */
export function invalidateAfterQuestion(qc: QueryClient, channelId?: string | null): void {
  void qc.invalidateQueries({ queryKey: questionKeys.all });
  void qc.invalidateQueries({ queryKey: SIBLING_KEYS.todo });
  void qc.invalidateQueries({ queryKey: weldchatKeys.channels() });
  void qc.invalidateQueries({ queryKey: ['entity-channel'] });
  if (channelId) void qc.invalidateQueries({ queryKey: weldchatKeys.messages(channelId) });
}

/** The questions the caller may see, a page at a time by the server's cursor. */
export function useInfiniteQuestions(
  filters: Omit<QuestionListParams, 'cursor' | 'limit'>,
  options: { enabled?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: questionKeys.list(filters),
    queryFn: ({ pageParam }) => questionsApi.list({ ...filters, cursor: pageParam, limit: QUESTIONS_PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: QuestionPage) => (last.pagination.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    enabled: (options.enabled ?? true) && isQuestionsAvailable(),
    placeholderData: keepPreviousData,
    select: (data: InfiniteData<QuestionPage, string | null>) => {
      // A question that moved between pages while loading would show twice.
      const seen = new Set<string>();
      const items = data.pages
        .flatMap((page) => page.data)
        .filter((question) => {
          if (seen.has(question.id)) return false;
          seen.add(question.id);
          return true;
        });
      return { items, totalCount: data.pages.at(-1)?.pagination.totalCount ?? items.length };
    },
  });
}

/** Ask a question about one record. */
export function useAskQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AskQuestionInput) => questionsApi.ask(input).then((res) => res.data),
    onSuccess: (question) => invalidateAfterQuestion(qc, question.channelId),
  });
}

/** Ask the same question about several records (a bank line each). */
export function useAskQuestionsBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AskQuestionsBulkInput) => questionsApi.askMany(input).then((res) => res.data),
    onSuccess: () => invalidateAfterQuestion(qc),
  });
}

/** Mark a question resolved, or re-open it. The thread's first message carries the status, so its cache is patched too. */
export function useSetQuestionStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, status }: { messageId: string; channelId?: string | null; status: QuestionStatus }) =>
      questionsApi.setStatus(messageId, status).then((res) => res.data),
    onSuccess: (question: Question, variables) => {
      const channelId = variables.channelId ?? question.channelId;
      if (channelId) {
        // The thread's first message carries the status: patch it, so the chip changes at once.
        updateMessageInCache(qc, channelId, question.id, {
          metadata: { question: { status: question.status, askedTo: question.askedTo.map((person) => person.id) } },
        });
      }
      invalidateAfterQuestion(qc, channelId);
    },
  });
}

/** What is still open in a VAT return's period. Only where the edition has it and while the person may read reports. */
export function useVatReturnChecks(vatReturnId: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: questionKeys.vatChecks(vatReturnId ?? ''),
    queryFn: async () => (await questionsApi.vatChecks(vatReturnId!)).data,
    enabled: !!vatReturnId && (options.enabled ?? true) && isQuestionsAvailable(),
  });
}

/** The date the entity's books could be locked at. */
export function useLockDateSuggestion(entityId: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: questionKeys.lockSuggestion(entityId ?? ''),
    queryFn: async () => (await questionsApi.lockDateSuggestion(entityId!)).data,
    enabled: !!entityId && (options.enabled ?? true) && isQuestionsAvailable(),
  });
}

/** What a review mark changes: the entry, the lists of entries and the bank lines that show its mark. */
export function invalidateAfterReview(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: SIBLING_KEYS.journalEntries });
  void qc.invalidateQueries({ queryKey: SIBLING_KEYS.bankTransactions });
}

/** Mark one journal entry reviewed, or take the mark off. */
export function useSetJournalEntryReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ journalEntryId, reviewed }: { journalEntryId: string; reviewed: boolean }) =>
      reviewed ? questionsApi.review(journalEntryId) : questionsApi.unreview(journalEntryId),
    onSuccess: () => invalidateAfterReview(qc),
  });
}

/** Mark several journal entries reviewed at once. */
export function useReviewJournalEntriesBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => questionsApi.reviewBulk(ids).then((res) => res.data),
    onSuccess: () => invalidateAfterReview(qc),
  });
}

/** What marking the bookings of bank lines found: the entries marked, the ones left as they were, the lines with no booking. */
export interface ReviewLinesResult {
  reviewed: string[];
  skipped: string[];
  withoutEntry: number;
}

/**
 * Mark the bookings of bank lines reviewed. A line's journal entry is on its
 * links (read once, then cached), so the lines are resolved to entries first
 * and marked in one call.
 */
export function useReviewBankLines() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (lineIds: string[]): Promise<ReviewLinesResult> => {
      const links = await Promise.all(
        lineIds.map((lineId) =>
          qc.fetchQuery({
            queryKey: SIBLING_KEYS.bankLineLinks(lineId),
            queryFn: async () => (await bankingApi.getBankLineLinks(lineId)).data,
            staleTime: 60_000,
          }),
        ),
      );
      const entryIds = [...new Set(links.flatMap((link) => (link.journalEntry ? [link.journalEntry.id] : [])))];
      const withoutEntry = links.filter((link) => !link.journalEntry).length;
      if (entryIds.length === 0) return { reviewed: [], skipped: [], withoutEntry };
      const result = (await questionsApi.reviewBulk(entryIds)).data;
      return { ...result, withoutEntry };
    },
    onSuccess: () => invalidateAfterReview(qc),
  });
}
