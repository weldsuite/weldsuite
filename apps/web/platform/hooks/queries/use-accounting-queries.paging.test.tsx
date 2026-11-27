import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));

import {
  useAccountingContactBalance,
  useAccountingContactSearch,
  useInfiniteAccountingAccountTransactions,
  useInfiniteAccountingBills,
  useInfiniteAccountingCustomers,
  useInfiniteAccountingInvoices,
  useInfiniteAccountingJournalEntries,
} from './use-accounting-queries';

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function pageOf(rows: unknown[], page: number, hasMore: boolean) {
  return { data: rows, pagination: { page, pageSize: 50, totalCount: 120, totalPages: 3, hasMore } };
}

/** The query string the last request carried, as an object. */
function lastQuery(): Record<string, string> {
  const path = String(api.get.mock.calls.at(-1)?.[0]);
  return Object.fromEntries(new URLSearchParams(path.split('?')[1] ?? ''));
}

beforeEach(() => {
  api.get.mockReset();
  client.clear();
});

describe('the lists that stop at 25 rows now page', () => {
  it('asks for the customers 50 at a time and loads the next page on request', async () => {
    api.get.mockImplementation(async (path: string) =>
      path.includes('page=2') ? pageOf([{ id: 'c3' }], 2, false) : pageOf([{ id: 'c1' }, { id: 'c2' }], 1, true),
    );
    const { result } = renderHook(() => useInfiniteAccountingCustomers({ role: 'customer', search: 'acme' }), { wrapper });

    await waitFor(() => expect(result.current.data?.rows).toHaveLength(2));
    expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/^\/accounting-contacts\?/));
    expect(lastQuery()).toMatchObject({ role: 'customer', search: 'acme', page: '1', pageSize: '50' });
    expect(result.current.data?.totalCount).toBe(120);
    expect(result.current.hasNextPage).toBe(true);

    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.rows.map((row) => row.id)).toEqual(['c1', 'c2', 'c3']));
    expect(lastQuery()).toMatchObject({ page: '2', pageSize: '50' });
    expect(result.current.hasNextPage).toBe(false);
  });

  it('sends the journal search and status to the server, 50 entries a page', async () => {
    api.get.mockResolvedValue(pageOf([{ id: 'je_1' }], 1, false));
    const { result } = renderHook(() => useInfiniteAccountingJournalEntries({ status: 'posted', search: 'rent' }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data?.rows).toHaveLength(1));
    expect(api.get.mock.calls[0][0]).toMatch(/^\/journal-entries\?/);
    expect(lastQuery()).toEqual({ status: 'posted', search: 'rent', page: '1', pageSize: '50' });
  });
});

describe('the contact panel\'s queries', () => {
  it('asks for the invoices and the bills of one contact', async () => {
    api.get.mockResolvedValue(pageOf([], 1, false));
    const invoices = renderHook(() => useInfiniteAccountingInvoices({ contactId: 'prt_1' }), { wrapper });
    await waitFor(() => expect(invoices.result.current.isSuccess).toBe(true));
    expect(api.get.mock.calls[0][0]).toMatch(/^\/invoices\?/);
    expect(lastQuery()).toMatchObject({ contactId: 'prt_1', page: '1' });

    api.get.mockClear();
    const bills = renderHook(() => useInfiniteAccountingBills({ contactId: 'prt_1' }), { wrapper });
    await waitFor(() => expect(bills.result.current.isSuccess).toBe(true));
    expect(api.get.mock.calls[0][0]).toMatch(/^\/bills\?/);
    expect(lastQuery()).toMatchObject({ contactId: 'prt_1', page: '1' });
  });

  it('does not ask while the tab is not open', () => {
    renderHook(() => useInfiniteAccountingInvoices({ contactId: 'prt_1' }, { enabled: false }), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('reads the contact\'s balance', async () => {
    api.get.mockResolvedValue({
      data: { receivable: { totalOutstanding: '5', totalOverdue: '1' }, payable: { totalOutstanding: '0', totalOverdue: '0' } },
    });
    const { result } = renderHook(() => useAccountingContactBalance('prt_1'), { wrapper });

    await waitFor(() => expect(result.current.data?.data.receivable.totalOutstanding).toBe('5'));
    expect(api.get).toHaveBeenCalledWith('/accounting-contacts/prt_1/balance');
  });

  it('pages the account\'s transactions', async () => {
    api.get.mockResolvedValue(pageOf([{ id: 'jl_1' }], 1, true));
    const { result } = renderHook(() => useInfiniteAccountingAccountTransactions('acc_1'), { wrapper });

    await waitFor(() => expect(result.current.data?.rows).toHaveLength(1));
    expect(api.get.mock.calls[0][0]).toMatch(/^\/gl-accounts\/acc_1\/transactions\?/);
    expect(lastQuery()).toEqual({ page: '1', pageSize: '50' });
    expect(result.current.hasNextPage).toBe(true);
  });
});

describe('the contact picker\'s search', () => {
  it('asks the server for the contacts of the role that match what was typed', async () => {
    api.get.mockResolvedValue(pageOf([{ id: 'cus_1', name: 'Globex' }], 1, false));
    const { result } = renderHook(() => useAccountingContactSearch('supplier'), { wrapper });

    const found = await result.current('  glob ');
    expect(found).toEqual([{ id: 'cus_1', name: 'Globex' }]);
    expect(lastQuery()).toEqual({ role: 'supplier', search: 'glob', pageSize: '30' });

    await result.current('');
    expect(lastQuery()).toEqual({ role: 'supplier', pageSize: '30' });
  });

  it('keeps one search function between renders', () => {
    const { result, rerender } = renderHook(() => useAccountingContactSearch('customer'), { wrapper });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
