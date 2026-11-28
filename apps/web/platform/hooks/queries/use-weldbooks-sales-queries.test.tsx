import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRuntimeConfig } from '@/lib/runtime-config';

const api = vi.hoisted(() => ({
  emailInvoice: vi.fn(),
  revokeInvoiceLink: vi.fn(),
  remindInvoice: vi.fn(),
  remindBulk: vi.fn(),
  setRemindersPaused: vi.fn(),
  invoiceFromQuote: vi.fn(),
  listQuotes: vi.fn(),
  getQuote: vi.fn(),
  createQuote: vi.fn(),
  updateQuote: vi.fn(),
  emailQuote: vi.fn(),
  revokeQuoteLink: vi.fn(),
  getEmailTemplates: vi.fn(),
  updateEmailTemplates: vi.fn(),
  getReminderSettings: vi.fn(),
  updateReminderSettings: vi.fn(),
}));
vi.mock('@/lib/api/domains/weldbooks-sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/domains/weldbooks-sales')>()),
  salesApi: api,
}));

import {
  isInvoiceEmailAvailable,
  isQuotesAvailable,
  isRemindersAvailable,
  salesKeys,
  useCreateQuote,
  useEmailInvoice,
  useEmailQuote,
  useInfiniteQuotes,
  useInvoiceFromQuote,
  usePauseReminders,
  useRemindBulk,
  useRemindInvoice,
  useRevokeInvoiceLink,
  useRevokeQuoteLink,
  useUpdateEmailTemplates,
  useUpdateQuote,
  useUpdateReminderSettings,
} from './use-weldbooks-sales-queries';

const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: Readonly<{ children: ReactNode }>) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, invalidate, wrapper };
}

const invalidated = (spy: ReturnType<typeof setup>['invalidate']) => spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
const INVOICES = JSON.stringify(['accounting', 'invoices']);
const QUOTES = JSON.stringify(['accounting', 'quotes']);
const TODO = JSON.stringify(['accounting', 'todo']);

describe('edition gates', () => {
  afterEach(() => setRuntimeConfig(null));

  it('are open on a Rust install that has the features, and closed where one is missing', () => {
    setRuntimeConfig(RUST);
    expect([isInvoiceEmailAvailable(), isQuotesAvailable(), isRemindersAvailable()]).toEqual([true, true, true]);
    setRuntimeConfig({ ...RUST, unavailableFeatures: ['books-quotes'] });
    expect([isInvoiceEmailAvailable(), isQuotesAvailable(), isRemindersAvailable()]).toEqual([true, false, true]);
  });
});

describe('sales mutations', () => {
  beforeEach(() => {
    setRuntimeConfig(RUST);
    for (const fn of Object.values(api)) fn.mockReset();
  });
  afterEach(() => setRuntimeConfig(null));

  it('e-mailing an invoice remembers its link and refreshes the invoice, the ledger and To process', async () => {
    const { client, invalidate, wrapper } = setup();
    api.emailInvoice.mockResolvedValue({ data: { delivery: { messageId: 'm', to: ['a@b.test'], subject: 's', link: 'https://pay.example.test/d/1' } } });
    const { result } = renderHook(() => useEmailInvoice(), { wrapper });
    await result.current.mutateAsync({ id: 'inv_1', input: { to: ['a@b.test'] } });
    expect(client.getQueryData(salesKeys.link('invoice', 'inv_1'))).toBe('https://pay.example.test/d/1');
    const keys = invalidated(invalidate);
    expect(keys).toContain(INVOICES);
    expect(keys).toContain(JSON.stringify(['accounting', 'invoices', 'detail', 'inv_1']));
    expect(keys).toContain(TODO);
    expect(keys).toContain(JSON.stringify(['accounting', 'journal-entries']));
  });

  it('the link a send brought back is kept for the card, and revoking it leaves the document with none', async () => {
    const { client, invalidate, wrapper } = setup();
    client.setQueryData(salesKeys.link('invoice', 'inv_1'), 'https://pay.example.test/d/1');
    expect(client.getQueryData(salesKeys.link('invoice', 'inv_1'))).toBe('https://pay.example.test/d/1');

    api.revokeInvoiceLink.mockResolvedValue({ data: { id: 'inv_1', linkRevoked: true } });
    const { result } = renderHook(() => useRevokeInvoiceLink(), { wrapper });
    await result.current.mutateAsync('inv_1');
    expect(client.getQueryData(salesKeys.link('invoice', 'inv_1'))).toBeNull();
    expect(invalidated(invalidate)).toContain(INVOICES);
  });

  it('a reminder, a bulk reminder and a pause refresh the invoices and To process', async () => {
    const { client, invalidate, wrapper } = setup();
    api.remindInvoice.mockResolvedValue({ data: { reminder: { level: 1, to: ['a@b.test'], messageId: 'm', subject: 's', link: 'https://pay.example.test/d/2' } } });
    api.remindBulk.mockResolvedValue({ data: { sent: [], skipped: [] } });
    api.setRemindersPaused.mockResolvedValue({ data: {} });
    const { result } = renderHook(() => ({ remind: useRemindInvoice(), bulk: useRemindBulk(), pause: usePauseReminders() }), { wrapper });

    await result.current.remind.mutateAsync('inv_1');
    expect(client.getQueryData(salesKeys.link('invoice', 'inv_1'))).toBe('https://pay.example.test/d/2');
    await result.current.bulk.mutateAsync(['inv_1', 'inv_2']);
    expect(api.remindBulk).toHaveBeenCalledWith(['inv_1', 'inv_2']);
    await result.current.pause.mutateAsync({ id: 'inv_1', paused: true });
    expect(api.setRemindersPaused).toHaveBeenCalledWith('inv_1', true);

    const keys = invalidated(invalidate);
    expect(keys.filter((key) => key === INVOICES)).toHaveLength(3);
    expect(keys.filter((key) => key === TODO)).toHaveLength(3);
  });

  it('making an invoice from a quote refreshes the quotes, the invoices and To process', async () => {
    const { invalidate, wrapper } = setup();
    api.invoiceFromQuote.mockResolvedValue({ data: { id: 'inv_9' } });
    const { result } = renderHook(() => useInvoiceFromQuote(), { wrapper });
    await result.current.mutateAsync({ quoteId: 'q_1', input: { percentage: 40 } });
    expect(api.invoiceFromQuote).toHaveBeenCalledWith('q_1', { percentage: 40 });
    const keys = invalidated(invalidate);
    expect(keys).toEqual(expect.arrayContaining([QUOTES, INVOICES, TODO]));
  });

  it('creating, changing, e-mailing and revoking a quote refresh the quotes, which carry the contact’s tab', async () => {
    const { client, invalidate, wrapper } = setup();
    api.createQuote.mockResolvedValue({ data: { id: 'q_1' } });
    api.updateQuote.mockResolvedValue({ data: { id: 'q_1' } });
    api.emailQuote.mockResolvedValue({ data: { delivery: { messageId: 'm', to: ['a@b.test'], subject: 's', link: 'https://pay.example.test/d/q' } } });
    api.revokeQuoteLink.mockResolvedValue({ data: { id: 'q_1', linkRevoked: true } });
    const { result } = renderHook(() => ({ create: useCreateQuote(), update: useUpdateQuote(), email: useEmailQuote(), revoke: useRevokeQuoteLink() }), { wrapper });
    const input = { contactId: 'c_1', name: 'N', lines: [] };
    await result.current.create.mutateAsync(input);
    await result.current.update.mutateAsync({ id: 'q_1', input });
    await result.current.email.mutateAsync({ id: 'q_1', input: { to: ['a@b.test'] } });
    expect(client.getQueryData(salesKeys.link('quote', 'q_1'))).toBe('https://pay.example.test/d/q');
    await result.current.revoke.mutateAsync('q_1');
    expect(client.getQueryData(salesKeys.link('quote', 'q_1'))).toBeNull();
    expect(invalidated(invalidate).filter((key) => key === QUOTES)).toHaveLength(4);
  });

  it('saved e-mail texts and reminder settings replace what the cache holds; the settings also refresh To process', async () => {
    const { client, invalidate, wrapper } = setup();
    const templates = { entityId: 'e', kinds: [], locales: [], placeholders: [], templates: {} };
    const settings = { enabled: false, steps: [], entityId: 'e', statutoryAvailable: false, statutoryCosts: { enabled: false, interest: false, commercialRate: 1, consumerRate: 1 } };
    api.updateEmailTemplates.mockResolvedValue({ data: templates });
    api.updateReminderSettings.mockResolvedValue({ data: settings });
    const { result } = renderHook(() => ({ templates: useUpdateEmailTemplates(), settings: useUpdateReminderSettings() }), { wrapper });
    await result.current.templates.mutateAsync({ invoice: { nl: null } });
    expect(api.updateEmailTemplates).toHaveBeenCalledWith({ invoice: { nl: null } });
    expect(client.getQueryData(salesKeys.emailTemplates())).toEqual(templates);
    await result.current.settings.mutateAsync({ enabled: false });
    expect(client.getQueryData(salesKeys.reminderSettings())).toEqual(settings);
    expect(invalidated(invalidate)).toContain(TODO);
  });

  it('pages the quotes by the server’s flag and sends the filters', async () => {
    const { wrapper } = setup();
    api.listQuotes
      .mockResolvedValueOnce({ data: [{ id: 'q_1' }], pagination: { totalCount: 2, hasMore: true } })
      .mockResolvedValueOnce({ data: [{ id: 'q_2' }], pagination: { totalCount: 2, hasMore: false } });
    const { result } = renderHook(() => useInfiniteQuotes({ status: 'sent', contactId: 'c_1' }), { wrapper });
    await waitFor(() => expect(result.current.data?.rows).toHaveLength(1));
    expect(api.listQuotes).toHaveBeenCalledWith({ status: 'sent', contactId: 'c_1', page: 1, pageSize: 25 });
    expect(result.current.hasNextPage).toBe(true);
    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.rows.map((row) => row.id)).toEqual(['q_1', 'q_2']));
    expect(api.listQuotes).toHaveBeenLastCalledWith({ status: 'sent', contactId: 'c_1', page: 2, pageSize: 25 });
    expect(result.current.hasNextPage).toBe(false);
  });
});
