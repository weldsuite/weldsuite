/**
 * Query hooks of sending, quotes and reminders (phase 4a). All of it is served
 * by the Rust backend only: gate the screens on `isInvoiceEmailAvailable()`,
 * `isQuotesAvailable()` and `isRemindersAvailable()`.
 *
 * Keys sit under `['accounting', ...]`, so the entity switch resets them with
 * the rest. The quote keys are `['accounting', 'quotes']`, which is what the
 * realtime sync map (`quote`) invalidates.
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
  salesApi,
  type EmailTemplatesPatch,
  type InvoiceFromQuoteInput,
  type QuoteInput,
  type QuoteListParams,
  type ReminderSettingsPatch,
  type SendEmailInput,
} from '@/lib/api/domains/weldbooks-sales';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { isFeatureAvailable } from '@/lib/edition';
import { accountingKeys } from './use-accounting-queries';

/** Whether this deployment e-mails invoices and quotes (the Rust backend only). */
export function isInvoiceEmailAvailable(): boolean {
  return isFeatureAvailable('books-invoice-email');
}

/** Whether this deployment has WeldBooks quotes (the Rust backend only). */
export function isQuotesAvailable(): boolean {
  return isFeatureAvailable('books-quotes');
}

/** Whether this deployment sends payment reminders (the Rust backend only). */
export function isRemindersAvailable(): boolean {
  return isFeatureAvailable('books-reminders');
}

/** The quotes list loads this many rows at a time (the server allows up to 100). */
export const QUOTES_PAGE_SIZE = 25;

/** The to-process queries (`todoKeys.all` in `use-weldbooks-todo-queries.ts`), named here so this module loads without that one. */
const TODO_QUERIES = ['accounting', 'todo'] as const;

export const salesKeys = {
  quotes: {
    all: ['accounting', 'quotes'] as const,
    list: (filters: QuoteListParams) => [...salesKeys.quotes.all, 'list', filters] as const,
    detail: (id: string) => [...salesKeys.quotes.all, 'detail', id] as const,
  },
  emailTemplates: () => [...accountingKeys.settings(), 'email-templates'] as const,
  reminderSettings: () => [...accountingKeys.settings(), 'reminders'] as const,
  /**
   * The public link of a document: read from the server (`usePublicLink` in `use-weldbooks-contact-page-queries.ts`),
   * and set by a send or a reminder, which bring it back, so the card has it before the next read.
   */
  link: (type: 'invoice' | 'quote', id: string) => [...accountingKeys.all, 'public-link', type, id] as const,
};

/** What e-mailing, reminding or pausing an invoice touches: the invoices and what To process counts. */
function invalidateInvoices(qc: QueryClient, id?: string) {
  void qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
  if (id) void qc.invalidateQueries({ queryKey: accountingKeys.invoices.detail(id) });
  void qc.invalidateQueries({ queryKey: TODO_QUERIES });
}

function rememberLink(qc: QueryClient, type: 'invoice' | 'quote', id: string, link: string | null | undefined) {
  if (link) qc.setQueryData(salesKeys.link(type, id), link);
}

// ============================================================================
// Sending
// ============================================================================

export function useEmailInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: SendEmailInput }) => salesApi.emailInvoice(id, input),
    onSuccess: (res, vars) => {
      rememberLink(qc, 'invoice', vars.id, res.data.delivery.link);
      invalidateInvoices(qc, vars.id);
      // Sending a draft finalizes (posts) it first.
      void qc.invalidateQueries({ queryKey: accountingKeys.journalEntries.all });
      void qc.invalidateQueries({ queryKey: accountingKeys.dashboard() });
    },
  });
}

export function useRevokeInvoiceLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => salesApi.revokeInvoiceLink(id),
    onSuccess: (_, id) => {
      // The old link no longer works: the document has none until it is sent again.
      qc.setQueryData(salesKeys.link('invoice', id), null);
      invalidateInvoices(qc, id);
    },
  });
}

export function useEmailQuote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: SendEmailInput }) => salesApi.emailQuote(id, input),
    onSuccess: (res, vars) => {
      rememberLink(qc, 'quote', vars.id, res.data.delivery.link);
      void qc.invalidateQueries({ queryKey: salesKeys.quotes.all });
    },
  });
}

export function useRevokeQuoteLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => salesApi.revokeQuoteLink(id),
    onSuccess: (_, id) => {
      qc.setQueryData(salesKeys.link('quote', id), null);
      void qc.invalidateQueries({ queryKey: salesKeys.quotes.all });
    },
  });
}

// ============================================================================
// Reminders
// ============================================================================

export function useRemindInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => salesApi.remindInvoice(id),
    onSuccess: (res, id) => {
      rememberLink(qc, 'invoice', id, res.data.reminder.link);
      invalidateInvoices(qc, id);
    },
  });
}

export function useRemindBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invoiceIds: string[]) => salesApi.remindBulk(invoiceIds),
    onSuccess: () => invalidateInvoices(qc),
  });
}

/** The most overdue invoices one bulk call takes, and so the most the To process card looks at. */
const REMINDER_DUE_LIMIT = 100;

/**
 * The overdue invoices whose next reminder is manual and due (the To process hint `reminder_due`):
 * what "Send N reminders" on the overdue card sends.
 */
export function useReminderDueItems(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...TODO_QUERIES, 'reminder-due'] as const,
    queryFn: async () =>
      (await accountingApi.listTodo({ kind: 'invoices_overdue', limit: REMINDER_DUE_LIMIT })).data.filter(
        (item) => item.hint === 'reminder_due',
      ),
    enabled: (options.enabled ?? true) && isRemindersAvailable(),
    staleTime: 15_000,
  });
}

export function usePauseReminders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) => salesApi.setRemindersPaused(id, paused),
    onSuccess: (_, vars) => invalidateInvoices(qc, vars.id),
  });
}

// ============================================================================
// Quotes
// ============================================================================

/** The quotes of the entity's contacts, a page at a time. */
export function useInfiniteQuotes(filters: Omit<QuoteListParams, 'page' | 'pageSize'> = {}, options: { enabled?: boolean } = {}) {
  const enabled = (options.enabled ?? true) && isQuotesAvailable();
  return useInfiniteQuery({
    queryKey: [...salesKeys.quotes.list(filters), 'infinite'] as const,
    queryFn: ({ pageParam }) => salesApi.listQuotes({ ...filters, page: pageParam, pageSize: QUOTES_PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => (last.pagination.hasMore ? pages.length + 1 : undefined),
    select: (data) => ({
      rows: data.pages.flatMap((page) => page.data),
      totalCount: data.pages.at(-1)?.pagination.totalCount ?? 0,
    }),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useQuote(id: string) {
  return useQuery({
    queryKey: salesKeys.quotes.detail(id),
    queryFn: async () => (await salesApi.getQuote(id)).data,
    enabled: !!id && isQuotesAvailable(),
  });
}

export function useCreateQuote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: QuoteInput) => salesApi.createQuote(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: salesKeys.quotes.all }),
  });
}

export function useUpdateQuote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: QuoteInput }) => salesApi.updateQuote(id, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: salesKeys.quotes.all }),
  });
}

/** Makes a draft invoice (or an advance invoice for a share) from a quote. */
export function useInvoiceFromQuote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ quoteId, input }: { quoteId: string; input: InvoiceFromQuoteInput }) =>
      salesApi.invoiceFromQuote(quoteId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: salesKeys.quotes.all });
      invalidateInvoices(qc);
    },
  });
}

// ============================================================================
// Settings
// ============================================================================

export function useEmailTemplates(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesKeys.emailTemplates(),
    queryFn: async () => (await salesApi.getEmailTemplates()).data,
    enabled: (options.enabled ?? true) && isInvoiceEmailAvailable(),
  });
}

export function useUpdateEmailTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (templates: EmailTemplatesPatch) => salesApi.updateEmailTemplates(templates),
    onSuccess: (res) => qc.setQueryData(salesKeys.emailTemplates(), res.data),
  });
}

export function useReminderSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: salesKeys.reminderSettings(),
    queryFn: async () => (await salesApi.getReminderSettings()).data,
    enabled: (options.enabled ?? true) && isRemindersAvailable(),
    staleTime: 60_000,
  });
}

export function useUpdateReminderSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ReminderSettingsPatch) => salesApi.updateReminderSettings(patch),
    onSuccess: (res) => {
      qc.setQueryData(salesKeys.reminderSettings(), res.data);
      // The timelines and the cards read the workflow.
      void qc.invalidateQueries({ queryKey: TODO_QUERIES });
    },
  });
}
