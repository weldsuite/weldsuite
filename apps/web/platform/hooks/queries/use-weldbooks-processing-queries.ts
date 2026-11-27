/**
 * Query hooks of the bank-line processing view (phase 2). Everything here is
 * served by the Rust backend only: gate the screens on `isBankProcessingAvailable()`.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import {
  processingApi,
  type ApplyPaymentInput,
  type CategorizeInput,
  type DifferenceSettingsInput,
} from '@/lib/api/domains/weldbooks-processing';
import { isFeatureAvailable } from '@/lib/edition';
import { accountingKeys } from './use-accounting-queries';
import { todoKeys } from './use-weldbooks-todo-queries';

/** Whether this deployment can process bank lines the new way (the Rust backend only). */
export function isBankProcessingAvailable(): boolean {
  return isFeatureAvailable('books-bank-processing');
}

export const processingKeys = {
  ruleSuggestion: (lineId: string) => [...accountingKeys.bankTransactions.all, 'rule-suggestion', lineId] as const,
  differences: () => [...accountingKeys.settings(), 'differences'] as const,
  credits: (contactId: string) => [...accountingKeys.all, 'contact-credits', contactId] as const,
  unlinkedDocuments: () => [...accountingKeys.documents.all, 'unlinked'] as const,
};

/**
 * What processing a line touches: the queue and the line, the bank balances,
 * the to-process counts, the inbox documents, the documents a payment settled
 * and the ledger.
 */
export function invalidateAfterProcessing(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: accountingKeys.bankTransactions.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.bankAccounts.all });
  void qc.invalidateQueries({ queryKey: todoKeys.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.documents.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.bills.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.payments.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.accounts.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
}

/** Book a line to one category, or split it over several (they are posted as one entry). */
export function useCategorizeBankLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, data }: { lineId: string; data: CategorizeInput }) =>
      processingApi.categorize(lineId, data).then((res) => res.data),
    onSuccess: () => invalidateAfterProcessing(qc),
  });
}

/** Book a line as a transfer to one of the entity's own accounts. */
export function useTransferBankLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, bankAccountId }: { lineId: string; bankAccountId?: string }) =>
      processingApi.transfer(lineId, bankAccountId ? { bankAccountId } : {}).then((res) => res.data),
    onSuccess: () => invalidateAfterProcessing(qc),
  });
}

/** Book a line as paid privately. */
export function usePrivateBankLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lineId: string) => processingApi.markPrivate(lineId).then((res) => res.data),
    onSuccess: () => invalidateAfterProcessing(qc),
  });
}

/** Link an inbox document to a line. It books nothing. */
export function useAttachDocumentToBankLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, documentId }: { lineId: string; documentId: string }) =>
      processingApi.attachDocument(lineId, documentId).then((res) => res.data),
    onSuccess: () => invalidateAfterProcessing(qc),
  });
}

/** The one Undo, for every way a line can be processed. */
export function useUndoBankLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lineId: string) => processingApi.undo(lineId).then((res) => res.data),
    onSuccess: () => invalidateAfterProcessing(qc),
  });
}

/** Save the notes of a line; an empty text clears them. */
export function useUpdateBankLineNotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, notes }: { lineId: string; notes: string | null }) =>
      processingApi.updateNotes(lineId, notes),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: accountingKeys.bankTransactions.all });
    },
  });
}

/** The rule worth offering once a line is booked, or null when the history shows none. */
export function useRuleSuggestion(lineId: string | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: processingKeys.ruleSuggestion(lineId ?? ''),
    queryFn: async () => (await processingApi.ruleSuggestion(lineId!)).data,
    enabled: !!lineId && (options.enabled ?? true),
    staleTime: 30_000,
  });
}

/** "Make this a rule": the pre-fill from how a booked line was booked. */
export function useRuleFromTransaction() {
  return useMutation({
    mutationFn: (lineId: string) => processingApi.ruleFromTransaction(lineId).then((res) => res.data),
  });
}

export function useDifferenceSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: processingKeys.differences(),
    queryFn: async () => (await processingApi.getDifferenceSettings()).data,
    enabled: (options.enabled ?? true) && isBankProcessingAvailable(),
  });
}

export function useUpdateDifferenceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: DifferenceSettingsInput) => processingApi.updateDifferenceSettings(data).then((res) => res.data),
    onSuccess: (settings) => {
      qc.setQueryData(processingKeys.differences(), settings);
    },
  });
}

/** The credit a contact has left over, one row per payment with money not yet applied. */
export function useContactCredits(contactId: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: processingKeys.credits(contactId ?? ''),
    queryFn: async () => (await processingApi.listCredits(contactId!)).data,
    enabled: !!contactId && (options.enabled ?? true) && isBankProcessingAvailable(),
  });
}

/** Apply credit left on a payment to an open invoice or bill of the same contact. */
export function useApplyPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentId, data }: { paymentId: string; data: ApplyPaymentInput }) =>
      processingApi.applyPayment(paymentId, data).then((res) => res.data),
    onSuccess: () => {
      invalidateAfterProcessing(qc);
      void qc.invalidateQueries({ queryKey: [...accountingKeys.all, 'contact-credits'] });
    },
  });
}

/** One payment, read when an unapplied-credit item is opened, to find the contact it belongs to. */
export function fetchCreditPayment(qc: QueryClient, paymentId: string) {
  return qc.fetchQuery({
    queryKey: [...accountingKeys.payments.all, 'detail', paymentId] as const,
    queryFn: async () => (await accountingApi.getPayment(paymentId)).data,
    staleTime: 60_000,
  });
}

/**
 * The inbox documents not yet linked to anything, newest first. The documents
 * route returns one page (the newest 100), so the search is over that page.
 */
export function useUnlinkedInboxDocuments(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: processingKeys.unlinkedDocuments(),
    queryFn: async () => {
      const rows = (await accountingApi.listDocuments()).data ?? [];
      return rows.filter((doc) => !doc.linkedEntityId && doc.status !== 'rejected');
    },
    enabled: options.enabled ?? true,
  });
}
