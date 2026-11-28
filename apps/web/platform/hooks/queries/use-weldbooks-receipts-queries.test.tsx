import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const env = vi.hoisted(() => ({
  available: true,
  list: vi.fn(),
  listBills: vi.fn(),
  pendingBills: vi.fn(),
}));

vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => env.available }));
vi.mock('@/lib/api/domains/weldbooks', () => ({
  accountingApi: { listBills: (...args: unknown[]) => env.listBills(...args), rejectDocument: vi.fn() },
}));
vi.mock('@/lib/api/domains/weldbooks-receipts', () => ({
  receiptsApi: { listDocuments: (...args: unknown[]) => env.list(...args) },
  batchesApi: { pendingBills: (...args: unknown[]) => env.pendingBills(...args) },
}));

import {
  INBOX_PAGE_SIZE,
  batchKeys,
  fetchPayableEurBills,
  receiptKeys,
  useEntityDocuments,
  usePendingBillMap,
} from './use-weldbooks-receipts-queries';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  env.available = true;
  env.list.mockReset();
  env.listBills.mockReset();
  env.pendingBills.mockReset();
});

describe('query keys', () => {
  it('keep the SEPA keys where the realtime sync map invalidates them', () => {
    expect(batchKeys.all).toEqual(['accounting', 'payment-batches']);
    expect(batchKeys.list()[0]).toBe('accounting');
    expect(batchKeys.list()[1]).toBe('payment-batches');
    expect(batchKeys.pending().slice(0, 2)).toEqual(['accounting', 'payment-batches']);
    // The bills a batch or a booking changes are under `['accounting', 'bills']`.
    expect(batchKeys.payable().slice(0, 2)).toEqual(['accounting', 'bills']);
  });

  it('keep the inbox documents under the documents key, which a booking and an upload invalidate', () => {
    expect(receiptKeys.documentPages(undefined).slice(0, 2)).toEqual(['accounting', 'documents']);
    expect(receiptKeys.prefill('doc_1').slice(0, 2)).toEqual(['accounting', 'documents']);
    expect(receiptKeys.entityStats().slice(0, 2)).toEqual(['accounting', 'documents']);
  });
});

describe('useEntityDocuments', () => {
  it('reads a page at a time from the entity and puts the pages together with the real total', async () => {
    env.list
      .mockResolvedValueOnce({ data: [{ id: 'a', status: 'processed' }, { id: 'b', status: 'processed' }], pagination: { totalCount: 3, hasMore: true } })
      .mockResolvedValueOnce({ data: [{ id: 'b', status: 'processed' }, { id: 'c', status: 'linked' }], pagination: { totalCount: 3, hasMore: false } });
    const { result } = renderHook(() => useEntityDocuments('processed'), { wrapper });

    await waitFor(() => expect(result.current.data?.items).toHaveLength(2));
    expect(env.list).toHaveBeenCalledWith({ status: 'processed', page: 1, pageSize: INBOX_PAGE_SIZE });
    expect(result.current.hasNextPage).toBe(true);
    expect(result.current.data?.totalCount).toBe(3);

    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.items.map((doc) => doc.id)).toEqual(['a', 'b', 'c']));
    expect(env.list).toHaveBeenLastCalledWith({ status: 'processed', page: 2, pageSize: INBOX_PAGE_SIZE });
    expect(result.current.hasNextPage).toBe(false);
  });

  it('asks nothing where the edition has no receipts', () => {
    env.available = false;
    renderHook(() => useEntityDocuments(undefined), { wrapper });
    expect(env.list).not.toHaveBeenCalled();
  });
});

describe('fetchPayableEurBills', () => {
  const bill = (id: string, overrides: Record<string, unknown> = {}) => ({ id, currency: 'EUR', balanceDue: '10.00', dueDate: '2026-12-01', ...overrides });

  it('reads every open status page by page, keeps euro bills with a balance and sorts by due date', async () => {
    env.listBills.mockImplementation(async ({ status, page }: { status: string; page: number }) => {
      if (status === 'approved' && page === 1) return { data: [bill('late', { dueDate: '2026-12-20' })], pagination: { hasMore: true } };
      if (status === 'approved' && page === 2) return { data: [bill('usd', { currency: 'USD' }), bill('paid-up', { balanceDue: '0.00' })], pagination: { hasMore: false } };
      if (status === 'partial') return { data: [bill('early', { dueDate: '2026-11-30' })], pagination: { hasMore: false } };
      return { data: [], pagination: { hasMore: false } };
    });

    const bills = await fetchPayableEurBills();

    expect(bills.map((row) => row.id)).toEqual(['early', 'late']);
    expect(env.listBills).toHaveBeenCalledWith({ status: 'approved', page: 2, pageSize: 100 });
    expect(env.listBills).toHaveBeenCalledWith({ status: 'overdue', page: 1, pageSize: 100 });
  });
});

describe('usePendingBillMap', () => {
  it('maps the pending bills by id', async () => {
    env.pendingBills.mockResolvedValue({ data: [{ billId: 'bill_1', batchId: 'b_1', executionDate: '2026-12-01' }] });
    const { result } = renderHook(() => usePendingBillMap(), { wrapper });

    await waitFor(() => expect(result.current.get('bill_1')).toEqual({ batchId: 'b_1', executionDate: '2026-12-01' }));
  });

  it('is empty, and asks nothing, where the edition has no SEPA files', () => {
    env.available = false;
    const { result } = renderHook(() => usePendingBillMap(), { wrapper });
    expect(result.current.size).toBe(0);
    expect(env.pendingBills).not.toHaveBeenCalled();
  });
});
