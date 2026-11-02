import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api/domains/weldbooks', () => ({
  accountingApi: {
    createEntity: vi.fn(async () => ({ data: { id: 'ent_1' } })),
    createAccount: vi.fn(async () => ({ data: { id: 'acc_1' } })),
  },
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApiClient: () => ({ getClient: vi.fn() }) }));

import {
  accountingKeys,
  isEntityScopedAccountingQuery,
  resetEntityScopedAccountingQueries,
  useCreateAccount,
  useCreateAccountingEntity,
} from './use-accounting-queries';

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
