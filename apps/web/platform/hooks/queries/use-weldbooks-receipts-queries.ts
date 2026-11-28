/**
 * Query hooks of the inbox, the review screen and "Pay bills" (phase 3). All of
 * it is served by the Rust backend only: gate the screens on
 * `isReceiptsAvailable()` and `isSepaBatchesAvailable()`.
 *
 * Keys sit under `['accounting', ...]`, so the entity switch resets them with
 * the rest. The SEPA keys are `['accounting', 'payment-batches']` and the bills
 * are `['accounting', 'bills']`, which is what the realtime sync map
 * (`payment_batch`, `accounting_document`) invalidates.
 */
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  batchesApi,
  receiptsApi,
  type BankCandidateOverrides,
  type BookDocumentInput,
  type CreateBatchInput,
} from '@/lib/api/domains/weldbooks-receipts';
import { accountingApi, type Bill } from '@/lib/api/domains/weldbooks';
import { isFeatureAvailable } from '@/lib/edition';
import { accountingKeys } from './use-accounting-queries';

/** Whether this deployment has the inbox per entity and one-call booking (the Rust backend only). */
export function isReceiptsAvailable(): boolean {
  return isFeatureAvailable('books-receipts');
}

/** Whether this deployment can make SEPA payment files (the Rust backend only). */
export function isSepaBatchesAvailable(): boolean {
  return isFeatureAvailable('books-sepa-batches');
}

/** The inbox page loads this many documents at a time (the server allows up to 100). */
export const INBOX_PAGE_SIZE = 25;

/** The review screen looks this far ahead for the next document to check. */
export const NEXT_DOCUMENT_WINDOW = 100;

/** The to-process queries (`todoKeys.all` in `use-weldbooks-todo-queries.ts`), named here so this module loads without that one. */
const TODO_QUERIES = ['accounting', 'todo'] as const;

export const receiptKeys = {
  inbox: (entityId: string) => [...accountingKeys.entities.all, 'inbox', entityId] as const,
  documentPages: (status: string | undefined) =>
    [...accountingKeys.documents.all, 'entity-pages', status ?? 'all'] as const,
  entityStats: () => [...accountingKeys.documents.stats(), 'entity'] as const,
  document: (id: string) => [...accountingKeys.documents.all, 'detail', id] as const,
  prefill: (id: string) => [...accountingKeys.documents.all, 'prefill', id] as const,
  duplicates: (id: string) => [...accountingKeys.documents.all, 'duplicates', id] as const,
  candidates: (id: string, overrides: BankCandidateOverrides) =>
    [...accountingKeys.documents.all, 'bank-candidates', id, overrides] as const,
  next: () => [...accountingKeys.documents.all, 'next'] as const,
  bookingDefaults: (contactId: string) => [...accountingKeys.all, 'booking-defaults', contactId] as const,
};

export const batchKeys = {
  all: ['accounting', 'payment-batches'] as const,
  list: (status?: string) => [...batchKeys.all, 'list', status ?? 'all'] as const,
  pending: () => [...batchKeys.all, 'pending-bills'] as const,
  payable: () => [...accountingKeys.bills.all, 'payable-eur'] as const,
};

/** What booking or rejecting a document touches: the documents, the bills, payments, bank lines and the to-process counts. */
export function invalidateAfterBooking(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: accountingKeys.documents.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.bills.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.payments.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.bankTransactions.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
  void qc.invalidateQueries({ queryKey: TODO_QUERIES });
}

// ============================================================================
// Inbox per entity
// ============================================================================

export function useEntityInbox(entityId: string | null | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: receiptKeys.inbox(entityId ?? ''),
    queryFn: async () => (await receiptsApi.getInbox(entityId!)).data,
    enabled: !!entityId && (options.enabled ?? true) && isReceiptsAvailable(),
  });
}

export function useSetEntityInbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ entityId, email }: { entityId: string; email: string }) =>
      receiptsApi.setInbox(entityId, email).then((res) => res.data),
    onSuccess: (inbox, { entityId }) => {
      qc.setQueryData(receiptKeys.inbox(entityId), inbox);
    },
  });
}

// ============================================================================
// Documents
// ============================================================================

/** The entity's documents, a page at a time, with the server's real total. */
export function useEntityDocuments(status: string | undefined, options: { enabled?: boolean } = {}) {
  const enabled = (options.enabled ?? true) && isReceiptsAvailable();
  return useInfiniteQuery({
    queryKey: receiptKeys.documentPages(status),
    queryFn: ({ pageParam }) => receiptsApi.listDocuments({ status, page: pageParam, pageSize: INBOX_PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => (last.pagination.hasMore ? pages.length + 1 : undefined),
    enabled,
    // A document being scanned changes by itself: look again while one is.
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.data.some((doc) => doc.status === 'processing')) ? 2000 : false,
    select: (data) => {
      const seen = new Set<string>();
      const items = data.pages
        .flatMap((page) => page.data)
        .filter((doc) => {
          if (seen.has(doc.id)) return false;
          seen.add(doc.id);
          return true;
        });
      return { items, totalCount: data.pages.at(-1)?.pagination.totalCount ?? items.length };
    },
  });
}

/** The documents per status of this entity: the real counts, not the first page's. */
export function useEntityDocumentStats(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: receiptKeys.entityStats(),
    queryFn: async () => (await receiptsApi.getDocumentStats()).data,
    enabled: (options.enabled ?? true) && isReceiptsAvailable(),
  });
}

export function useInboxDocument(id: string | undefined) {
  return useQuery({
    queryKey: receiptKeys.document(id ?? ''),
    queryFn: async () => (await receiptsApi.getDocument(id!)).data,
    enabled: !!id,
  });
}

export function useDocumentPrefill(id: string | undefined) {
  return useQuery({
    queryKey: receiptKeys.prefill(id ?? ''),
    queryFn: async () => (await receiptsApi.getPrefill(id!)).data,
    enabled: !!id && isReceiptsAvailable(),
    // The form starts from this once; a refetch must not rewrite what was typed.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useDocumentDuplicates(id: string | undefined) {
  return useQuery({
    queryKey: receiptKeys.duplicates(id ?? ''),
    queryFn: async () => (await receiptsApi.getDuplicates(id!)).data,
    enabled: !!id && isReceiptsAvailable(),
  });
}

/** The bank lines that could have paid the document, best first; the overrides follow what is typed in the form. */
export function useBankCandidates(id: string | undefined, overrides: BankCandidateOverrides, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: receiptKeys.candidates(id ?? '', overrides),
    queryFn: async () => (await receiptsApi.getBankCandidates(id!, overrides)).data,
    enabled: !!id && (options.enabled ?? true) && isReceiptsAvailable(),
    placeholderData: keepPreviousData,
  });
}

/** The documents of this entity that still need checking, to pick the next one from. */
export function useNextDocuments(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: receiptKeys.next(),
    queryFn: async () => (await receiptsApi.listDocuments({ page: 1, pageSize: NEXT_DOCUMENT_WINDOW })).data,
    enabled: (options.enabled ?? true) && isReceiptsAvailable(),
  });
}

/** A supplier's usual category, VAT rate and project, worked out from their last bills. */
export function useBookingDefaults(contactId: string | null | undefined) {
  return useQuery({
    queryKey: receiptKeys.bookingDefaults(contactId ?? ''),
    queryFn: async () => (await receiptsApi.getBookingDefaults(contactId!)).data,
    enabled: !!contactId && isReceiptsAvailable(),
    staleTime: 60_000,
  });
}

/** Book a document as a bill, receipt or credit note, paid or not, in one call. */
export function useBookDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BookDocumentInput }) =>
      receiptsApi.bookDocument(id, input).then((res) => res.data),
    onSuccess: () => invalidateAfterBooking(qc),
  });
}

/** "Not for the books": the existing reject route. */
export function useRejectDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => accountingApi.rejectDocument(id),
    onSuccess: () => invalidateAfterBooking(qc),
  });
}

// ============================================================================
// SEPA batches
// ============================================================================

export function usePaymentBatches(status?: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: batchKeys.list(status),
    queryFn: () => batchesApi.list({ status, page: 1, pageSize: 50 }),
    enabled: (options.enabled ?? true) && isSepaBatchesAvailable(),
    placeholderData: keepPreviousData,
  });
}

/** The bills in an exported batch whose bank lines have not arrived yet ("Payment pending"). */
export function usePendingBills(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: batchKeys.pending(),
    queryFn: async () => (await batchesApi.pendingBills()).data,
    enabled: (options.enabled ?? true) && isSepaBatchesAvailable(),
    staleTime: 30_000,
  });
}

/** The pending set as a lookup by bill id, or an empty one where the edition has no batches. */
export function usePendingBillMap(): ReadonlyMap<string, { batchId: string; executionDate: string }> {
  const pending = usePendingBills();
  return new Map((pending.data ?? []).map((row) => [row.billId, { batchId: row.batchId, executionDate: row.executionDate }]));
}

/** Statuses of a bill that still waits to be paid. */
const PAYABLE_STATUSES = ['approved', 'partial', 'overdue'] as const;
/** The bills list pages at 100; a long list is read page by page, never cut off. */
const BILLS_PAGE_SIZE = 100;
const MAX_BILL_PAGES = 20;

/** Every approved bill in euros with something left to pay, soonest due first. */
export async function fetchPayableEurBills(): Promise<Bill[]> {
  const bills: Bill[] = [];
  for (const status of PAYABLE_STATUSES) {
    for (let page = 1; page <= MAX_BILL_PAGES; page += 1) {
      const res = await accountingApi.listBills({ status, page, pageSize: BILLS_PAGE_SIZE });
      bills.push(...(res.data ?? []));
      if (!res.pagination?.hasMore) break;
    }
  }
  return bills
    .filter((bill) => (bill.currency ?? 'EUR') === 'EUR' && Number(bill.balanceDue ?? 0) > 0)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
}

/** The bills "Pay bills" offers. */
export function usePayableEurBills(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: batchKeys.payable(),
    queryFn: fetchPayableEurBills,
    enabled: (options.enabled ?? true) && isSepaBatchesAvailable(),
  });
}

/** What a batch changes: the batches, the pending set, the bills that show "Payment pending". */
function invalidateBatches(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: batchKeys.all });
  void qc.invalidateQueries({ queryKey: accountingKeys.bills.all });
  void qc.invalidateQueries({ queryKey: TODO_QUERIES });
}

export function useCreatePaymentBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBatchInput) => batchesApi.create(input).then((res) => res.data),
    onSuccess: () => invalidateBatches(qc),
  });
}

export function useCancelPaymentBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => batchesApi.cancel(id),
    onSuccess: () => invalidateBatches(qc),
  });
}
