import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const env = vi.hoisted(() => ({ questions: true }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@/lib/edition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/edition')>();
  return {
    ...actual,
    isFeatureAvailable: (feature: Parameters<typeof actual.isFeatureAvailable>[0]) =>
      feature === 'books-questions' ? env.questions : actual.isFeatureAvailable(feature),
  };
});

import { accountingKeys } from './use-accounting-queries';
import { bankingKeys } from './use-weldbooks-banking-queries';
import { todoKeys } from './use-weldbooks-todo-queries';
import { weldchatKeys } from './use-weldchat-queries';
import {
  SIBLING_KEYS,
  questionKeys,
  useAskQuestion,
  useAskQuestionsBulk,
  useInfiniteQuestions,
  useLockDateSuggestion,
  useReviewBankLines,
  useReviewJournalEntriesBulk,
  useSetJournalEntryReview,
  useSetQuestionStatus,
  useVatReturnChecks,
} from './use-weldbooks-questions-queries';
import { invalidateAfterProcessing } from './use-weldbooks-processing-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, invalidate, wrapper };
}

const invalidated = (spy: ReturnType<typeof setup>['invalidate']) => spy.mock.calls.map(([filters]) => filters?.queryKey);

beforeEach(() => {
  env.questions = true;
  for (const fn of Object.values(api)) fn.mockReset();
});

describe('the keys this file spells out stay the real ones', () => {
  it('matches the to-process, journal entry, bank line and link keys', () => {
    expect(SIBLING_KEYS.todo).toEqual(todoKeys.all);
    expect(SIBLING_KEYS.journalEntries).toEqual(accountingKeys.journalEntries.all);
    expect(SIBLING_KEYS.bankTransactions).toEqual(accountingKeys.bankTransactions.all);
    expect(SIBLING_KEYS.bankLineLinks('btx_1')).toEqual(bankingKeys.lines.links('btx_1'));
  });

  it('sits under the accounting root, so switching the entity resets it', () => {
    expect(questionKeys.all.slice(0, 1)).toEqual(accountingKeys.all);
    expect(questionKeys.list({}).slice(0, 2)).toEqual(questionKeys.all);
    expect(questionKeys.vatChecks('vat_1').slice(0, 1)).toEqual(accountingKeys.all);
    expect(questionKeys.lockSuggestion('ent_1').slice(0, 1)).toEqual(accountingKeys.all);
  });

  it('is refreshed when processing a bank line (a receipt or a booking answers its questions)', () => {
    const { client, invalidate } = setup();
    invalidateAfterProcessing(client);
    expect(invalidated(invalidate)).toContainEqual(questionKeys.all);
  });
});

describe('the question mutations', () => {
  it('asking refreshes the questions, To process and the record chat', async () => {
    const { invalidate, wrapper } = setup();
    api.post.mockResolvedValue({ data: { id: 'msg_1', channelId: 'ch_1', createdChannel: true } });
    const { result } = renderHook(() => useAskQuestion(), { wrapper });
    result.current.mutate({ recordType: 'invoice', recordId: 'inv_1', text: 'Why?' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.post).toHaveBeenCalledWith('/accounting-questions', { recordType: 'invoice', recordId: 'inv_1', text: 'Why?' });
    const keys = invalidated(invalidate);
    expect(keys).toContainEqual(questionKeys.all);
    expect(keys).toContainEqual(todoKeys.all);
    expect(keys).toContainEqual(weldchatKeys.channels());
    expect(keys).toContainEqual(['entity-channel']);
    expect(keys).toContainEqual(weldchatKeys.messages('ch_1'));
  });

  it('asking about several records refreshes them too', async () => {
    const { invalidate, wrapper } = setup();
    api.post.mockResolvedValue({ data: { created: [], failed: [] } });
    const { result } = renderHook(() => useAskQuestionsBulk(), { wrapper });
    result.current.mutate({ recordType: 'bank_transaction', recordIds: ['b1', 'b2'], text: 'Receipt?' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.post).toHaveBeenCalledWith('/accounting-questions/bulk', {
      recordType: 'bank_transaction',
      recordIds: ['b1', 'b2'],
      text: 'Receipt?',
    });
    expect(invalidated(invalidate)).toContainEqual(questionKeys.all);
    expect(invalidated(invalidate)).toContainEqual(todoKeys.all);
  });

  it('changing the status patches the thread starter and refreshes its chat', async () => {
    const { invalidate, wrapper } = setup();
    api.patch.mockResolvedValue({ data: { id: 'msg_1', channelId: 'ch_1', status: 'resolved', askedTo: [] } });
    const { result } = renderHook(() => useSetQuestionStatus(), { wrapper });
    result.current.mutate({ messageId: 'msg_1', status: 'resolved' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.patch).toHaveBeenCalledWith('/accounting-questions/msg_1', { status: 'resolved' });
    expect(invalidated(invalidate)).toContainEqual(weldchatKeys.messages('ch_1'));
    expect(invalidated(invalidate)).toContainEqual(todoKeys.all);
  });
});

describe('the questions list', () => {
  it('asks the server for the filters and the cursor, and lists each question once', async () => {
    const { wrapper } = setup();
    api.get.mockResolvedValue({
      data: [{ id: 'q1' }, { id: 'q1' }, { id: 'q2' }],
      pagination: { totalCount: 3, hasMore: false, cursor: null },
    });
    const { result } = renderHook(() => useInfiniteQuestions({ status: 'open', askedTo: 'me', recordType: 'bill' }), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(api.get).toHaveBeenCalledWith('/accounting-questions?status=open&askedTo=me&recordType=bill&limit=25');
    expect(result.current.data?.items.map((q) => q.id)).toEqual(['q1', 'q2']);
  });

  it('asks for nothing on Global', () => {
    env.questions = false;
    const { wrapper } = setup();
    const { result } = renderHook(() => useInfiniteQuestions({}), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('the check and the lock date', () => {
  it('reads the checks of one return, and only where the edition has them', async () => {
    const { wrapper } = setup();
    api.get.mockResolvedValue({ data: { unprocessed_bank_lines: { count: 1, sampleIds: ['b1'] } } });
    const { result } = renderHook(() => useVatReturnChecks('vat_1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(api.get).toHaveBeenCalledWith('/vat-returns/vat_1/checks');

    env.questions = false;
    api.get.mockClear();
    const off = renderHook(() => useVatReturnChecks('vat_2'), { wrapper });
    expect(off.result.current.fetchStatus).toBe('idle');
    expect(api.get).not.toHaveBeenCalled();
  });

  it('reads the suggested lock date of an entity, unless told not to', async () => {
    const { wrapper } = setup();
    api.get.mockResolvedValue({ data: { suggestedDate: '2026-09-30', reason: 'end_of_last_month' } });
    const { result } = renderHook(() => useLockDateSuggestion('ent 1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(api.get).toHaveBeenCalledWith('/accounting-entities/ent%201/lock-date-suggestion');

    api.get.mockClear();
    const off = renderHook(() => useLockDateSuggestion('ent_2', { enabled: false }), { wrapper });
    expect(off.result.current.fetchStatus).toBe('idle');
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('the review marks', () => {
  it('marks and unmarks one entry, and refreshes the entries and the bank lines that show the mark', async () => {
    const { invalidate, wrapper } = setup();
    api.post.mockResolvedValue({ data: {} });
    api.delete.mockResolvedValue({ data: {} });
    const { result } = renderHook(() => useSetJournalEntryReview(), { wrapper });
    result.current.mutate({ journalEntryId: 'je_1', reviewed: true });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/journal-entries/je_1/review'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    result.current.mutate({ journalEntryId: 'je_1', reviewed: false });
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/journal-entries/je_1/review'));
    expect(invalidated(invalidate)).toContainEqual(accountingKeys.journalEntries.all);
    expect(invalidated(invalidate)).toContainEqual(accountingKeys.bankTransactions.all);
  });

  it('marks several entries in one call', async () => {
    const { wrapper } = setup();
    api.post.mockResolvedValue({ data: { reviewed: ['je_1'], skipped: ['je_2'] } });
    const { result } = renderHook(() => useReviewJournalEntriesBulk(), { wrapper });
    result.current.mutate(['je_1', 'je_2']);
    await waitFor(() => expect(result.current.data).toEqual({ reviewed: ['je_1'], skipped: ['je_2'] }));
    expect(api.post).toHaveBeenCalledWith('/journal-entries/review-bulk', { ids: ['je_1', 'je_2'] });
  });

  it('marks the bookings of bank lines: reads each line\'s entry once, then marks them together', async () => {
    const { wrapper } = setup();
    api.get.mockImplementation(async (path: string) => {
      const journalEntry = (id: string | null) => (id ? { id, entryNumber: null, date: '', description: null, sourceType: null, sourceId: null } : null);
      if (path === '/bank-transactions/b1/links') return { data: { journalEntry: journalEntry('je_1') } };
      if (path === '/bank-transactions/b2/links') return { data: { journalEntry: journalEntry('je_1') } };
      if (path === '/bank-transactions/b3/links') return { data: { journalEntry: journalEntry(null) } };
      throw new Error(path);
    });
    api.post.mockResolvedValue({ data: { reviewed: ['je_1'], skipped: [] } });
    const { result } = renderHook(() => useReviewBankLines(), { wrapper });
    result.current.mutate(['b1', 'b2', 'b3']);
    await waitFor(() => expect(result.current.data).toBeDefined());
    // Two lines share one entry: it is sent once. A line with no booking of its own is counted, not sent.
    expect(api.post).toHaveBeenCalledWith('/journal-entries/review-bulk', { ids: ['je_1'] });
    expect(result.current.data).toEqual({ reviewed: ['je_1'], skipped: [], withoutEntry: 1 });
  });

  it('calls nothing when none of the lines has a booking', async () => {
    const { wrapper } = setup();
    api.get.mockResolvedValue({ data: { journalEntry: null } });
    const { result } = renderHook(() => useReviewBankLines(), { wrapper });
    result.current.mutate(['b1']);
    await waitFor(() => expect(result.current.data).toEqual({ reviewed: [], skipped: [], withoutEntry: 1 }));
    expect(api.post).not.toHaveBeenCalled();
  });
});
