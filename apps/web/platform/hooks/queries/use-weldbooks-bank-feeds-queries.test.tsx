import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));

import { accountingKeys, isEntityScopedAccountingQuery } from './use-accounting-queries';
import {
  bankFeedKeys,
  useDeleteBankFeed,
  useDisconnectBankFeed,
  useMapBankFeedAccounts,
  useSyncBankFeed,
} from './use-weldbooks-bank-feeds-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const invalidated = () => invalidate.mock.calls.map(([filters]) => (filters as { queryKey: readonly unknown[] }).queryKey);
  return { wrapper, invalidated };
}

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.delete.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bank feed query keys', () => {
  it('are entity scoped: switching the accounting entity resets them', () => {
    for (const key of [
      bankFeedKeys.connections(),
      bankFeedKeys.providers('US'),
      bankFeedKeys.institutions('enable_banking', 'NL'),
      bankFeedKeys.pending('bkc_1', 'ba_1'),
    ]) {
      expect(isEntityScopedAccountingQuery(key)).toBe(true);
    }
  });

  it('keep pending transactions per connection and bank account', () => {
    expect(bankFeedKeys.pending('bkc_1')).not.toEqual(bankFeedKeys.pending('bkc_1', 'ba_1'));
    expect(bankFeedKeys.pending('bkc_1', 'ba_1')).not.toEqual(bankFeedKeys.pending('bkc_2', 'ba_1'));
  });
});

describe('bank feed mutations', () => {
  it('refresh the connections, the bank accounts and their transactions after mapping, and again once the first sync had time to run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.post.mockResolvedValue({ data: { connection: {}, mapped: [], syncStarted: true } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useMapBankFeedAccounts(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ connectionId: 'bkc_1', input: { mappings: [{ feedAccountId: 'fa_1', bankAccountId: 'ba_1' }] } });
    });

    expect(api.post).toHaveBeenCalledWith('/bank-connections/bkc_1/map-accounts', {
      mappings: [{ feedAccountId: 'fa_1', bankAccountId: 'ba_1' }],
    });
    expect(invalidated()).toEqual(
      expect.arrayContaining([bankFeedKeys.connections(), accountingKeys.bankAccounts.all, accountingKeys.bankTransactions.all]),
    );

    const before = invalidated().length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(13_000);
    });
    expect(invalidated().length).toBeGreaterThan(before);
    expect(invalidated()).toContainEqual(bankFeedKeys.all);
  });

  it('look at the transactions again after a sync, even when the provider failed', async () => {
    api.post.mockResolvedValue({ data: { outcome: { error: 'RATE_LIMIT' }, connection: {} } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useSyncBankFeed(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ connectionId: 'bkc_1', refresh: true });
    });

    expect(api.post).toHaveBeenCalledWith('/bank-connections/bkc_1/sync', { refresh: true });
    expect(invalidated()).toEqual(
      expect.arrayContaining([bankFeedKeys.all, accountingKeys.bankTransactions.all]),
    );
  });

  it('disconnect and delete refresh the bank accounts, which lose or keep their link', async () => {
    api.post.mockResolvedValue({ data: {} });
    api.delete.mockResolvedValue(undefined);
    const { wrapper, invalidated } = setup();
    const disconnect = renderHook(() => useDisconnectBankFeed(), { wrapper });
    const remove = renderHook(() => useDeleteBankFeed(), { wrapper });

    await act(async () => {
      await disconnect.result.current.mutateAsync('bkc_1');
      await remove.result.current.mutateAsync('bkc_1');
    });

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/bank-connections/bkc_1'));
    expect(api.post).toHaveBeenCalledWith('/bank-connections/bkc_1/disconnect');
    expect(invalidated().filter((key) => key === accountingKeys.bankAccounts.all)).toHaveLength(2);
  });
});
