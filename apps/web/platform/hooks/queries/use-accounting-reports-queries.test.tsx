import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({
  getProfitLoss: vi.fn(),
  getGeneralLedger: vi.fn(),
  getTaxLines: vi.fn(),
  listDimensionValues: vi.fn(),
  applyTaxLines: vi.fn(),
  updateEntity: vi.fn(),
  updateAccount: vi.fn(),
}));

vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: api }));

import {
  accountingKeys,
  isEntityScopedAccountingQuery,
  useApplyTaxLines,
  useDimensionValues,
  useGeneralLedgerReport,
  useProfitLossReport,
  useTaxLineCatalog,
  useUpdateAccount,
  useUpdateAccountingEntity,
} from './use-accounting-queries';

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.map((call) => (call[0] as { queryKey: unknown[] }).queryKey);
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
});

describe('query keys of the US setup and reports', () => {
  it('keys a report by name and request so a changed option is a new query', () => {
    expect(accountingKeys.reports.report('profit-loss', { basis: 'cash' })).toEqual([
      'accounting',
      'reports',
      'profit-loss',
      { basis: 'cash' },
    ]);
    expect(accountingKeys.reports.report('profit-loss', { basis: 'cash' })).not.toEqual(
      accountingKeys.reports.report('profit-loss', { basis: 'accrual' }),
    );
    expect(accountingKeys.reports.report('cash-flow')).toEqual(['accounting', 'reports', 'cash-flow', {}]);
  });

  it('treats tax lines, dimensions and reports as per-entity data', () => {
    expect(isEntityScopedAccountingQuery(accountingKeys.taxLines.catalog())).toBe(true);
    expect(isEntityScopedAccountingQuery(accountingKeys.dimensions.list({ dimension: 'class' }))).toBe(true);
    expect(isEntityScopedAccountingQuery(accountingKeys.reports.report('tax-worksheet', { year: 2026 }))).toBe(true);
  });
});

describe('report hooks', () => {
  it('fetches a report with the toolbar request and returns the report itself', async () => {
    api.getProfitLoss.mockResolvedValue({ data: { basis: 'cash', columns: [] } });
    const { result } = renderHook(() => useProfitLossReport({ basis: 'cash', compare: 'prior_year' }), {
      wrapper: wrapperFor(newClient()),
    });

    await waitFor(() => expect(result.current.data).toEqual({ basis: 'cash', columns: [] }));
    expect(api.getProfitLoss).toHaveBeenCalledWith({ basis: 'cash', compare: 'prior_year' });
  });

  it('keeps the previous report on screen while the next one loads', async () => {
    api.getProfitLoss.mockResolvedValueOnce({ data: { basis: 'accrual' } });
    const { result, rerender } = renderHook(({ basis }) => useProfitLossReport({ basis }), {
      wrapper: wrapperFor(newClient()),
      initialProps: { basis: 'accrual' as 'accrual' | 'cash' },
    });
    await waitFor(() => expect(result.current.data).toEqual({ basis: 'accrual' }));

    let resolveNext: (value: unknown) => void = () => {};
    api.getProfitLoss.mockReturnValueOnce(new Promise((resolve) => (resolveNext = resolve)));
    rerender({ basis: 'cash' });

    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.data).toEqual({ basis: 'accrual' });
    resolveNext({ data: { basis: 'cash' } });
    await waitFor(() => expect(result.current.data).toEqual({ basis: 'cash' }));
  });

  it('does not ask for a general ledger before an account is chosen', async () => {
    renderHook(() => useGeneralLedgerReport({ accountId: '' }), { wrapper: wrapperFor(newClient()) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.getGeneralLedger).not.toHaveBeenCalled();
  });

  it('loads the tax line catalog and the dimension values on demand', async () => {
    api.getTaxLines.mockResolvedValue({ data: { form: 'sch_c', lines: [] } });
    api.listDimensionValues.mockResolvedValue({ data: [{ id: 'dim_1' }], pagination: {} });
    const wrapper = wrapperFor(newClient());

    const catalog = renderHook(() => useTaxLineCatalog(2025), { wrapper });
    await waitFor(() => expect(catalog.result.current.data).toEqual({ form: 'sch_c', lines: [] }));
    expect(api.getTaxLines).toHaveBeenCalledWith(2025);

    const dimensions = renderHook(() => useDimensionValues({ dimension: 'class', isActive: true }), { wrapper });
    await waitFor(() => expect(dimensions.result.current.data).toEqual([{ id: 'dim_1' }]));
    expect(api.listDimensionValues).toHaveBeenCalledWith({ dimension: 'class', isActive: true });

    const disabled = renderHook(() => useDimensionValues({ dimension: 'location' }, { enabled: false }), { wrapper });
    expect(disabled.result.current.fetchStatus).toBe('idle');
  });
});

describe('mutations that change what the reports show', () => {
  it('refreshes the reports and the entity after the accounting method or fiscal year changed', async () => {
    api.updateEntity.mockResolvedValue({ data: { id: 'ent_us', taxLineRemapNeeded: false } });
    const client = newClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateAccountingEntity(), { wrapper: wrapperFor(client) });

    await result.current.mutateAsync({ id: 'ent_us', data: { accountingMethod: 'cash' } });

    expect(api.updateEntity).toHaveBeenCalledWith('ent_us', { accountingMethod: 'cash' });
    const keys = invalidatedKeys(spy);
    expect(keys).toContainEqual(accountingKeys.entities.all);
    expect(keys).toContainEqual(accountingKeys.reports.all);
  });

  it('refreshes the accounts, the tax lines and the reports after a remap', async () => {
    api.applyTaxLines.mockResolvedValue({ data: { updated: 3 } });
    const client = newClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useApplyTaxLines(), { wrapper: wrapperFor(client) });

    await result.current.mutateAsync({ entityId: 'ent_us', data: { overwrite: true } });

    expect(api.applyTaxLines).toHaveBeenCalledWith('ent_us', { overwrite: true });
    const keys = invalidatedKeys(spy);
    expect(keys).toContainEqual(accountingKeys.accounts.all);
    expect(keys).toContainEqual(accountingKeys.taxLines.all);
    expect(keys).toContainEqual(accountingKeys.reports.all);
  });

  it('refreshes the reports when an account moves to another tax line', async () => {
    api.updateAccount.mockResolvedValue({ data: { id: 'acc_1' } });
    const client = newClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateAccount(), { wrapper: wrapperFor(client) });

    await result.current.mutateAsync({ id: 'acc_1', data: { taxLine: 'sch_c.8' } });

    expect(invalidatedKeys(spy)).toContainEqual(accountingKeys.reports.all);
  });
});
