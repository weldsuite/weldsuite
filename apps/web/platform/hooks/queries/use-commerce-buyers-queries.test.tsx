import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => api }),
}));

import {
  commerceBuyerKeys,
  useApproveCommerceOrder,
  useCommerceBuyers,
  useCompanyCommerceSettings,
  useDeleteCommerceBuyer,
  useInviteCommerceBuyer,
  useRejectCommerceOrder,
  useResendCommerceBuyerInvite,
  useUpdateCommerceBuyer,
  useUpdateCompanyCommerceSettings,
} from './use-commerce-buyers-queries';
import { commerceKeys } from './use-commerce-queries';
import { commerceOrderKeys } from './use-commerce-orders-queries';
import { commercePaymentKeys } from './use-commerce-payments-queries';

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  for (const fn of Object.values(api)) fn.mockReset();
  api.get.mockResolvedValue({ data: [] });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.put.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue(undefined);
});

function invalidated() {
  const spy = vi.spyOn(client, 'invalidateQueries');
  return () => spy.mock.calls.map(([filters]) => filters?.queryKey);
}

describe('query keys', () => {
  it('put buyers under weldcommerce / buyers and a company’s settings under company-settings', () => {
    expect(commerceBuyerKeys.all()).toEqual(['weldcommerce', 'buyers']);
    expect(commerceBuyerKeys.list({ companyId: 'cmp_1' }).slice(0, 2)).toEqual(['weldcommerce', 'buyers']);
    expect(commerceBuyerKeys.companySettings('cmp_1')).toEqual(['weldcommerce', 'company-settings', 'cmp_1']);
  });
});

describe('buyer reads', () => {
  it('lists the buyers of a company with the company in the query string', async () => {
    renderHook(() => useCommerceBuyers({ companyId: 'cmp_1' }), { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    expect(api.get).toHaveBeenCalledWith('/commerce-buyers?companyId=cmp_1');
  });

  it('does not ask without a company or person, or when disabled', () => {
    renderHook(() => useCommerceBuyers({}), { wrapper });
    renderHook(() => useCommerceBuyers({ companyId: 'cmp_1' }, false), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('reads the settings of a company, not without an id', async () => {
    renderHook(() => useCompanyCommerceSettings('cmp_1'), { wrapper });
    renderHook(() => useCompanyCommerceSettings(''), { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    expect(api.get).toHaveBeenCalledWith('/commerce-company-settings/cmp_1');
  });
});

describe('buyer writes', () => {
  it('invites a buyer and refreshes the buyers', async () => {
    const seen = invalidated();
    const { result } = renderHook(() => useInviteCommerceBuyer(), { wrapper });
    const body = { companyId: 'cmp_1', email: 'a@acme.test', role: 'buyer' as const, sendInvite: true };
    await act(async () => {
      await result.current.mutateAsync(body);
    });
    expect(api.post).toHaveBeenCalledWith('/commerce-buyers', body);
    expect(seen()).toContainEqual(commerceBuyerKeys.all());
  });

  it('patches a buyer and refreshes the buyers', async () => {
    const seen = invalidated();
    const { result } = renderHook(() => useUpdateCommerceBuyer(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'byr_1', data: { role: 'admin', spendLimit: null, spendLimitCurrency: null } });
    });
    expect(api.patch).toHaveBeenCalledWith('/commerce-buyers/byr_1', { role: 'admin', spendLimit: null, spendLimitCurrency: null });
    expect(seen()).toContainEqual(commerceBuyerKeys.all());
  });

  it('deletes a buyer and refreshes the buyers', async () => {
    const seen = invalidated();
    const { result } = renderHook(() => useDeleteCommerceBuyer(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('byr_1');
    });
    expect(api.delete).toHaveBeenCalledWith('/commerce-buyers/byr_1');
    expect(seen()).toContainEqual(commerceBuyerKeys.all());
  });

  it('sends the invitation again and refreshes the buyers', async () => {
    const seen = invalidated();
    const { result } = renderHook(() => useResendCommerceBuyerInvite(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('byr_1');
    });
    expect(api.post).toHaveBeenCalledWith('/commerce-buyers/byr_1/invite', {});
    expect(seen()).toContainEqual(commerceBuyerKeys.all());
  });

  it('does not refresh anything when a call fails', async () => {
    api.delete.mockRejectedValue(new Error('nope'));
    const seen = invalidated();
    const { result } = renderHook(() => useDeleteCommerceBuyer(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('byr_1').catch(() => undefined);
    });
    expect(seen()).toEqual([]);
  });
});

describe('company settings', () => {
  it('puts the threshold and refreshes that company’s settings only', async () => {
    const seen = invalidated();
    const { result } = renderHook(() => useUpdateCompanyCommerceSettings('cmp_1'), { wrapper });
    const body = { approvalThreshold: '2500.00', approvalThresholdCurrency: 'EUR' };
    await act(async () => {
      await result.current.mutateAsync(body);
    });
    expect(api.put).toHaveBeenCalledWith('/commerce-company-settings/cmp_1', body);
    expect(seen()).toEqual([commerceBuyerKeys.companySettings('cmp_1')]);
  });
});

describe('order approvals', () => {
  it('approves with the comment and refreshes the order, its lists, the overview and its payments', async () => {
    const seen = invalidated();
    const { result } = renderHook(() => useApproveCommerceOrder(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'ord_1', data: { comment: 'Fine' } });
    });
    expect(api.post).toHaveBeenCalledWith('/orders/ord_1/approve', { comment: 'Fine' });
    expect(seen()).toEqual(
      expect.arrayContaining([commerceOrderKeys.orders(), commerceKeys.overview(), commercePaymentKeys.order('ord_1')]),
    );
  });

  it('rejects without a comment as an empty body and refreshes the same', async () => {
    const seen = invalidated();
    const { result } = renderHook(() => useRejectCommerceOrder(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'ord_1' });
    });
    expect(api.post).toHaveBeenCalledWith('/orders/ord_1/reject', {});
    expect(seen()).toEqual(
      expect.arrayContaining([commerceOrderKeys.orders(), commerceKeys.overview(), commercePaymentKeys.order('ord_1')]),
    );
  });

  it('refreshes the order even when the approval is no longer pending (somebody decided first)', async () => {
    api.post.mockRejectedValue(Object.assign(new Error('no'), { status: 409 }));
    const seen = invalidated();
    const { result } = renderHook(() => useApproveCommerceOrder(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'ord_1' }).catch(() => undefined);
    });
    expect(seen()).toContainEqual(commerceOrderKeys.orders());
  });
});
