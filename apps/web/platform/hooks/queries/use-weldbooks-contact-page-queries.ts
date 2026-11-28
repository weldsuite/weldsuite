/**
 * Query hooks of the contact page (phase 5). Everything here is served by the
 * Rust backend only: gate the screens on `isContactPageAvailable()`.
 *
 * Keys of one contact sit under `accountingKeys.customers.detail(id)`, so
 * saving the contact refreshes its figures, and under `['accounting', ...]`,
 * so the entity switch resets them with the rest.
 */
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contactPageApi, type ContactDefaultsPatch } from '@/lib/api/domains/weldbooks-contact-page';
import { accountingApi, type BankTransaction, type Bill, type Invoice } from '@/lib/api/domains/weldbooks';
import { isFeatureAvailable } from '@/lib/edition';
import { accountingKeys, LIST_PAGE_SIZE } from './use-accounting-queries';
import { salesKeys } from './use-weldbooks-sales-queries';

/** Whether this deployment has the contact page (the Rust backend only). */
export function isContactPageAvailable(): boolean {
  return isFeatureAvailable('books-contact-page');
}

/** The timeline loads this many items at a time (the server allows up to 100). */
export const TIMELINE_PAGE_SIZE = 25;

/** Documents of the Invoices and Bills tabs load this many at a time. */
export const CONTACT_DOCUMENTS_PAGE_SIZE = 25;

/** The keys of the contact page's queries. */
export const contactPageKeys = {
  summary: (id: string) => [...accountingKeys.customers.detail(id), 'summary'] as const,
  timeline: (id: string) => [...accountingKeys.customers.detail(id), 'timeline'] as const,
  defaults: (id: string) => [...accountingKeys.customers.detail(id), 'defaults'] as const,
  statement: (id: string, asOf: string) => [...accountingKeys.customers.detail(id), 'statement', asOf] as const,
  documents: (id: string, kind: 'invoices' | 'bills') =>
    [...accountingKeys.customers.detail(id), 'documents', kind] as const,
  bankLines: (id: string) => [...accountingKeys.customers.detail(id), 'bank-lines'] as const,
  byCrm: (target: { companyId: string } | { personId: string }) =>
    [...accountingKeys.customers.all, 'by-crm', target] as const,
  publicLink: (type: 'invoice' | 'quote', id: string) => salesKeys.link(type, id),
};

/** What the contact owes and is owed, per currency, with the quotes and the unbilled hours. */
export function useContactSummary(contactId: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: contactPageKeys.summary(contactId ?? ''),
    queryFn: async () => (await contactPageApi.summary(contactId!)).data,
    enabled: !!contactId && (options.enabled ?? true) && isContactPageAvailable(),
  });
}

/** Everything about a contact by date, newest first, a page at a time (a cursor). */
export function useContactTimeline(contactId: string | undefined, options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: contactPageKeys.timeline(contactId ?? ''),
    queryFn: ({ pageParam }) => contactPageApi.timeline(contactId!, { cursor: pageParam, limit: TIMELINE_PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.pagination.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    select: (data) => ({
      items: data.pages.flatMap((page) => page.data),
      totalCount: data.pages[0]?.pagination.totalCount ?? 0,
    }),
    enabled: !!contactId && (options.enabled ?? true) && isContactPageAvailable(),
  });
}

function usePagedDocuments<T extends Invoice | Bill>(
  kind: 'invoices' | 'bills',
  contactId: string,
  options: { enabled?: boolean },
) {
  return useInfiniteQuery({
    queryKey: contactPageKeys.documents(contactId, kind),
    queryFn: ({ pageParam }) =>
      kind === 'invoices'
        ? contactPageApi.invoicesPage<T>(contactId, { page: pageParam, pageSize: CONTACT_DOCUMENTS_PAGE_SIZE })
        : contactPageApi.billsPage<T>(contactId, { page: pageParam, pageSize: CONTACT_DOCUMENTS_PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (last, _pages, lastPageParam) => (last.pagination.hasMore ? lastPageParam + 1 : undefined),
    select: (data) => ({
      rows: data.pages.flatMap((page) => page.data),
      totalCount: data.pages[0]?.pagination.totalCount ?? 0,
    }),
    enabled: !!contactId && (options.enabled ?? true),
    placeholderData: keepPreviousData,
  });
}

/** The contact's invoices through its own paged route (`/accounting-contacts/:id/invoices?page&pageSize`). */
export function useContactInvoicesPaged(contactId: string, options: { enabled?: boolean } = {}) {
  return usePagedDocuments<Invoice>('invoices', contactId, options);
}

/** The contact's bills through its own paged route. */
export function useContactBillsPaged(contactId: string, options: { enabled?: boolean } = {}) {
  return usePagedDocuments<Bill>('bills', contactId, options);
}

/** The bank lines linked to a contact, a page at a time. */
export function useContactBankLines(contactId: string | undefined, options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: contactPageKeys.bankLines(contactId ?? ''),
    queryFn: ({ pageParam }) =>
      accountingApi.listBankTransactions({ contactId: contactId!, page: pageParam, pageSize: LIST_PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (last, _pages, lastPageParam) => (last.pagination?.hasMore ? lastPageParam + 1 : undefined),
    select: (data): { rows: BankTransaction[]; totalCount: number | undefined } => ({
      rows: data.pages.flatMap((page) => page.data ?? []),
      totalCount: data.pages[0]?.pagination?.totalCount,
    }),
    enabled: !!contactId && (options.enabled ?? true) && isContactPageAvailable(),
  });
}

/** The defaults stored on a contact. */
export function useContactDefaults(contactId: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: contactPageKeys.defaults(contactId ?? ''),
    queryFn: async () => (await contactPageApi.defaults(contactId!)).data,
    enabled: !!contactId && (options.enabled ?? true) && isContactPageAvailable(),
  });
}

export function useUpdateContactDefaults(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ContactDefaultsPatch) => contactPageApi.updateDefaults(contactId, patch).then((res) => res.data),
    onSuccess: (defaults) => {
      qc.setQueryData(contactPageKeys.defaults(contactId), defaults);
      // Terms show on the header and the Details tab; paused reminders on the To process counts.
      void qc.invalidateQueries({ queryKey: accountingKeys.customers.detail(contactId) });
      void qc.invalidateQueries({ queryKey: ['accounting', 'todo'] });
    },
  });
}

/** The statement of a contact as of a date, for the preview. */
export function useContactStatement(contactId: string, asOf: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: contactPageKeys.statement(contactId, asOf),
    queryFn: async () => (await contactPageApi.statement(contactId, asOf || undefined)).data,
    enabled: !!contactId && (options.enabled ?? true) && isContactPageAvailable(),
  });
}

/** The WeldBooks contact behind a WeldCRM company or person, with its figures; `null` when there is none. */
export function useContactByCrm(
  target: { companyId: string } | { personId: string },
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: contactPageKeys.byCrm(target),
    queryFn: async () => (await contactPageApi.byCrm(target)).data,
    enabled: (options.enabled ?? true) && isContactPageAvailable(),
  });
}

/**
 * The public link of an invoice or a quote, from the server: the link is
 * derived on demand, so "Copy link" works any time and not only in the browser
 * that sent it. `null` while the document has none.
 */
export function usePublicLink(type: 'invoice' | 'quote', id: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: contactPageKeys.publicLink(type, id),
    queryFn: async () =>
      (type === 'invoice' ? await contactPageApi.invoicePublicLink(id) : await contactPageApi.quotePublicLink(id)).data
        .url,
    enabled: !!id && (options.enabled ?? true) && isContactPageAvailable(),
    staleTime: 60_000,
  });
}
