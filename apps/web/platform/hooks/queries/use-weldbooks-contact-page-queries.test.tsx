import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRuntimeConfig } from '@/lib/runtime-config';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), getBlob: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));

import {
  contactPageKeys,
  isContactPageAvailable,
  useContactBankLines,
  useContactBillsPaged,
  useContactByCrm,
  useContactDefaults,
  useContactInvoicesPaged,
  useContactStatement,
  useContactSummary,
  useContactTimeline,
  usePublicLink,
  useUpdateContactDefaults,
} from './use-weldbooks-contact-page-queries';

const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: Readonly<{ children: ReactNode }>) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, invalidate, wrapper };
}

/** The query string of the last request, as an object. */
function lastQuery(): Record<string, string> {
  const path = String(api.get.mock.calls.at(-1)?.[0]);
  return Object.fromEntries(new URLSearchParams(path.split('?')[1] ?? ''));
}

function timelineItem(id: string) {
  return { type: 'invoice', objectType: 'invoice', objectId: id, date: '2026-11-01T00:00:00Z', title: id };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  setRuntimeConfig(RUST);
});
afterEach(() => setRuntimeConfig(null));

describe('the contact page queries on Global', () => {
  it('are not offered, and send nothing, where the edition lacks the contact page', async () => {
    setRuntimeConfig(null);
    expect(isContactPageAvailable()).toBe(false);
    const { wrapper } = setup();
    const summary = renderHook(() => useContactSummary('prt_1'), { wrapper });
    const timeline = renderHook(() => useContactTimeline('prt_1'), { wrapper });
    const link = renderHook(() => usePublicLink('invoice', 'inv_1'), { wrapper });
    expect(summary.result.current.fetchStatus).toBe('idle');
    expect(timeline.result.current.fetchStatus).toBe('idle');
    expect(link.result.current.fetchStatus).toBe('idle');
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('the timeline', () => {
  it('pages by cursor: the next page asks for what the last one ended at', async () => {
    api.get.mockImplementation(async (path: string) =>
      path.includes('cursor=1700000000000%3Ai_2')
        ? { data: [timelineItem('i_3')], pagination: { totalCount: 3, hasMore: false, cursor: null } }
        : { data: [timelineItem('i_1'), timelineItem('i_2')], pagination: { totalCount: 3, hasMore: true, cursor: '1700000000000:i_2' } },
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useContactTimeline('prt_1'), { wrapper });

    await waitFor(() => expect(result.current.data?.items).toHaveLength(2));
    expect(String(api.get.mock.calls[0]?.[0])).toMatch(/^\/accounting-contacts\/prt_1\/timeline\?/);
    expect(lastQuery()).toEqual({ limit: '25' });
    expect(result.current.data?.totalCount).toBe(3);
    expect(result.current.hasNextPage).toBe(true);

    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.items.map((item) => item.objectId)).toEqual(['i_1', 'i_2', 'i_3']));
    expect(lastQuery()).toEqual({ cursor: '1700000000000:i_2', limit: '25' });
    expect(result.current.hasNextPage).toBe(false);
  });
});

describe('the summary, the by-CRM lookup and the statement', () => {
  it('reads the summary of a contact', async () => {
    api.get.mockResolvedValue({ data: { toReceive: [{ currency: 'EUR', amount: '10.00', count: 1 }] } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useContactSummary('prt_1'), { wrapper });
    await waitFor(() => expect(result.current.data?.toReceive).toHaveLength(1));
    expect(api.get).toHaveBeenCalledWith('/accounting-contacts/prt_1/summary');
  });

  it('looks a contact up by its WeldCRM company or person, and answers null for none', async () => {
    api.get.mockResolvedValue({ data: null });
    const { wrapper } = setup();
    const company = renderHook(() => useContactByCrm({ companyId: 'co_1' }), { wrapper });
    await waitFor(() => expect(company.result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/accounting-contacts/by-crm?companyId=co_1');
    expect(company.result.current.data).toBeNull();

    const person = renderHook(() => useContactByCrm({ personId: 'pe_1' }), { wrapper });
    await waitFor(() => expect(person.result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/accounting-contacts/by-crm?personId=pe_1');
  });

  it('reads the statement as JSON as of a date', async () => {
    api.get.mockResolvedValue({ data: { rows: [], totals: [], asOf: '2026-11-30' } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useContactStatement('prt_1', '2026-11-30'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(api.get.mock.calls[0]?.[0])).toMatch(/^\/accounting-contacts\/prt_1\/statement\?/);
    expect(lastQuery()).toEqual({ asOf: '2026-11-30', format: 'json' });
  });
});

describe('the paged documents and the bank lines', () => {
  const page = (rows: unknown[], hasMore: boolean) => ({ data: rows, pagination: { totalCount: 60, hasMore } });

  it('pages the invoices and the bills of a contact through its own routes, 25 at a time', async () => {
    api.get.mockImplementation(async (path: string) =>
      path.includes('page=2') ? page([{ id: 'inv_3' }], false) : page([{ id: 'inv_1' }, { id: 'inv_2' }], true),
    );
    const { wrapper } = setup();
    const invoices = renderHook(() => useContactInvoicesPaged('prt_1'), { wrapper });
    await waitFor(() => expect(invoices.result.current.data?.rows).toHaveLength(2));
    expect(String(api.get.mock.calls[0]?.[0])).toMatch(/^\/accounting-contacts\/prt_1\/invoices\?/);
    expect(lastQuery()).toEqual({ page: '1', pageSize: '25' });
    expect(invoices.result.current.data?.totalCount).toBe(60);

    await invoices.result.current.fetchNextPage();
    await waitFor(() => expect(invoices.result.current.data?.rows.map((row) => row.id)).toEqual(['inv_1', 'inv_2', 'inv_3']));
    expect(lastQuery()).toEqual({ page: '2', pageSize: '25' });

    api.get.mockClear();
    api.get.mockResolvedValue(page([], false));
    const bills = renderHook(() => useContactBillsPaged('prt_1'), { wrapper });
    await waitFor(() => expect(bills.result.current.isSuccess).toBe(true));
    expect(String(api.get.mock.calls[0]?.[0])).toMatch(/^\/accounting-contacts\/prt_1\/bills\?/);
  });

  it('can be switched off, so the old tab asks only the list it always did', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useContactInvoicesPaged('prt_1', { enabled: false }), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(api.get).not.toHaveBeenCalled();
  });

  it('asks for the bank lines of a contact by its id', async () => {
    api.get.mockResolvedValue({ data: [{ id: 'btx_1' }], pagination: { totalCount: 1, hasMore: false } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useContactBankLines('prt_1'), { wrapper });
    await waitFor(() => expect(result.current.data?.rows).toHaveLength(1));
    expect(String(api.get.mock.calls[0]?.[0])).toMatch(/^\/bank-transactions\?/);
    expect(lastQuery()).toMatchObject({ contactId: 'prt_1', page: '1' });
  });
});

describe('the defaults', () => {
  it('saves a change, keeps what the server answered and refreshes the contact and To process', async () => {
    let stored = { contactId: 'prt_1', defaultExpenseAccountId: null, defaultTaxRateId: null, paymentTermsDays: 14, remindersPaused: false } as Record<string, unknown>;
    api.get.mockImplementation(async () => ({ data: stored }));
    const answered = { contactId: 'prt_1', defaultExpenseAccountId: 'acc_1', defaultTaxRateId: null, paymentTermsDays: 14, remindersPaused: true };
    api.patch.mockImplementation(async () => {
      stored = answered;
      return { data: answered };
    });
    const { client, invalidate, wrapper } = setup();
    const defaults = renderHook(() => useContactDefaults('prt_1'), { wrapper });
    await waitFor(() => expect(defaults.result.current.data?.paymentTermsDays).toBe(14));

    const { result } = renderHook(() => useUpdateContactDefaults('prt_1'), { wrapper });
    await result.current.mutateAsync({ defaultExpenseAccountId: 'acc_1', remindersPaused: true });

    expect(api.patch).toHaveBeenCalledWith('/accounting-contacts/prt_1/defaults', { defaultExpenseAccountId: 'acc_1', remindersPaused: true });
    expect(client.getQueryData(contactPageKeys.defaults('prt_1'))).toEqual(answered);
    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['accounting', 'customers', 'detail', 'prt_1']));
    expect(keys).toContain(JSON.stringify(['accounting', 'todo']));
  });

  it('sends null to clear a value', async () => {
    api.patch.mockResolvedValue({ data: {} });
    const { wrapper } = setup();
    const { result } = renderHook(() => useUpdateContactDefaults('prt_1'), { wrapper });
    await result.current.mutateAsync({ paymentTermsDays: null });
    expect(api.patch).toHaveBeenCalledWith('/accounting-contacts/prt_1/defaults', { paymentTermsDays: null });
  });
});

describe('the public link', () => {
  it('asks the server for the link of an invoice and of a quote', async () => {
    api.get.mockResolvedValue({ data: { url: 'https://pay.example.test/d/abc' } });
    const { wrapper } = setup();
    const invoice = renderHook(() => usePublicLink('invoice', 'inv_1'), { wrapper });
    await waitFor(() => expect(invoice.result.current.data).toBe('https://pay.example.test/d/abc'));
    expect(api.get).toHaveBeenCalledWith('/invoices/inv_1/public-link');

    const quote = renderHook(() => usePublicLink('quote', 'q_1'), { wrapper });
    await waitFor(() => expect(quote.result.current.data).toBe('https://pay.example.test/d/abc'));
    expect(api.get).toHaveBeenCalledWith('/accounting-quotes/q_1/public-link');
  });

  it('is null while the document has no link, and is not asked for when disabled', async () => {
    api.get.mockResolvedValue({ data: { url: null } });
    const { wrapper } = setup();
    const none = renderHook(() => usePublicLink('invoice', 'inv_1'), { wrapper });
    await waitFor(() => expect(none.result.current.isSuccess).toBe(true));
    expect(none.result.current.data).toBeNull();

    api.get.mockClear();
    const off = renderHook(() => usePublicLink('invoice', 'inv_2', { enabled: false }), { wrapper });
    expect(off.result.current.fetchStatus).toBe('idle');
    expect(api.get).not.toHaveBeenCalled();
  });
});
