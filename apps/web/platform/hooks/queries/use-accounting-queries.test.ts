import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api/domains/weldbooks', () => ({
  accountingApi: {
    createEntity: vi.fn(async () => ({ data: { id: 'ent_1' } })),
    createAccount: vi.fn(async () => ({ data: { id: 'acc_1' } })),
    listBills: vi.fn(),
    listInvoices: vi.fn(),
  },
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApiClient: () => ({ getClient: vi.fn() }) }));

import {
  accountingKeys,
  isEntityScopedAccountingQuery,
  resetEntityScopedAccountingQueries,
  useCreateAccount,
  useCreateAccountingEntity,
  useInfiniteAccountingBills,
  useInfiniteAccountingInvoices,
} from './use-accounting-queries';
import { accountingApi } from '@/lib/api/domains/weldbooks';

describe('isEntityScopedAccountingQuery', () => {
  it('treats per-entity data as entity scoped', () => {
    expect(isEntityScopedAccountingQuery(accountingKeys.invoices.list({ status: 'draft' }))).toBe(true);
    expect(isEntityScopedAccountingQuery(accountingKeys.dashboard())).toBe(true);
    expect(isEntityScopedAccountingQuery(['accounting', 'reports', 'profit-loss', {}])).toBe(true);
  });

  it('keeps entity rows and jurisdictions', () => {
    expect(isEntityScopedAccountingQuery(['accounting', 'entities', 'ws_1'])).toBe(false);
    expect(isEntityScopedAccountingQuery(accountingKeys.entities.detail('ent_1'))).toBe(false);
    expect(isEntityScopedAccountingQuery(accountingKeys.jurisdictions())).toBe(false);
    expect(isEntityScopedAccountingQuery(['crm', 'companies'])).toBe(false);
  });
});

describe('resetEntityScopedAccountingQueries', () => {
  it("drops the previous entity's data but keeps the entity list", async () => {
    const qc = new QueryClient();
    qc.setQueryData(accountingKeys.invoices.list(), { data: [{ id: 'inv_nl' }] });
    qc.setQueryData(['accounting', 'entities', 'ws_1'], [{ id: 'ent_nl' }, { id: 'ent_us' }]);

    await resetEntityScopedAccountingQueries(qc);

    expect(qc.getQueryData(accountingKeys.invoices.list())).toBeUndefined();
    expect(qc.getQueryData(['accounting', 'entities', 'ws_1'])).toEqual([{ id: 'ent_nl' }, { id: 'ent_us' }]);
  });
});

describe('Getting Started checklist', () => {
  function setup() {
    const qc = new QueryClient();
    qc.setQueryData(['onboarding-checklist', 'data'], { dismissedApps: [], items: { accounting_chart_setup: false } });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    const isStale = () => qc.getQueryState(['onboarding-checklist', 'data'])?.isInvalidated;
    return { wrapper, isStale };
  }

  it('is refreshed when an entity is created, since that seeds its chart of accounts', async () => {
    const { wrapper, isStale } = setup();
    const { result } = renderHook(() => useCreateAccountingEntity(), { wrapper });

    await act(() => result.current.mutateAsync({ name: 'E2E Test BV' } as never));

    expect(isStale()).toBe(true);
  });

  it('is refreshed when an account is added to the chart', async () => {
    const { wrapper, isStale } = setup();
    const { result } = renderHook(() => useCreateAccount(), { wrapper });

    await act(() => result.current.mutateAsync({ code: '1100', name: 'Bank' }));

    expect(isStale()).toBe(true);
  });
});

describe('paged WeldBooks lists', () => {
  function wrapper() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    return Wrapper;
  }

  function page(ids: string[], hasMore: boolean, totalCount = 3) {
    return { data: ids.map((id) => ({ id })), pagination: { totalCount, hasMore, cursor: null } };
  }

  it('loads bills page by page until the API has no more', async () => {
    const listBills = vi.mocked(accountingApi.listBills);
    listBills.mockReset();
    listBills.mockResolvedValueOnce(page(['bil_1', 'bil_2'], true) as never);
    listBills.mockResolvedValueOnce(page(['bil_3'], false) as never);

    const { result } = renderHook(() => useInfiniteAccountingBills({ search: 'acme' }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.rows).toHaveLength(2));
    expect(result.current.data?.totalCount).toBe(3);
    expect(result.current.hasNextPage).toBe(true);
    expect(listBills).toHaveBeenLastCalledWith({ search: 'acme', page: 1, pageSize: 50 });

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.rows.map((row) => row.id)).toEqual(['bil_1', 'bil_2', 'bil_3']));
    expect(listBills).toHaveBeenLastCalledWith({ search: 'acme', page: 2, pageSize: 50 });
    expect(result.current.hasNextPage).toBe(false);
  });

  it('pages invoices with their filters', async () => {
    const listInvoices = vi.mocked(accountingApi.listInvoices);
    listInvoices.mockReset();
    listInvoices.mockResolvedValueOnce(page(['cn_1'], false, 1) as never);

    const { result } = renderHook(() => useInfiniteAccountingInvoices({ type: 'credit_note' }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.rows.map((row) => row.id)).toEqual(['cn_1']));
    expect(listInvoices).toHaveBeenCalledWith({ type: 'credit_note', page: 1, pageSize: 50 });
    expect(result.current.hasNextPage).toBe(false);
  });
});
