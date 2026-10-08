import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({
  previewImport: vi.fn(),
  importStatement: vi.fn(),
  completeReconciliation: vi.fn(),
  saveReconciliationProgress: vi.fn(),
  createDeposit: vi.fn(),
  matchPayment: vi.fn(),
  revealAccountNumber: vi.fn(),
  listUndeposited: vi.fn(),
}));

vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: {} }));
vi.mock('@/lib/api/domains/weldbooks-banking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/domains/weldbooks-banking')>()),
  bankingApi: api,
}));

import { accountingKeys, isEntityScopedAccountingQuery } from './use-accounting-queries';
import {
  bankingKeys,
  contentKey,
  useBankImportPreview,
  useCompleteBankReconciliation,
  useCreateBankDeposit,
  useImportBankStatement,
  useMatchBankLineToPayment,
  useRevealAccountNumber,
  useSaveBankReconciliationProgress,
  useUndepositedPayments,
} from './use-weldbooks-banking-queries';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const invalidated = () => invalidate.mock.calls.map(([filter]) => filter?.queryKey);
  return { client, wrapper, invalidated };
}

describe('banking query keys', () => {
  it('sit under the accounting keys, so switching entity resets them', () => {
    const keys = [
      bankingKeys.lines.list({ status: 'unreconciled' }),
      bankingKeys.lines.suggestions('bt_1'),
      bankingKeys.importPreview(['ba_1', 'a.csv', '12:ab', null, null]),
      bankingKeys.deposits.undeposited(),
      bankingKeys.deposits.list({ limit: 25 }),
      bankingKeys.deposits.detail('dep_1'),
      bankingKeys.reconciliations.list(),
      bankingKeys.reconciliations.detail('brec_1'),
      bankingKeys.reconciliations.report('brec_1'),
    ];
    for (const key of keys) expect(isEntityScopedAccountingQuery(key)).toBe(true);
  });

  it('are covered by the existing bank transaction invalidations', () => {
    const bankTransactionsPrefix = accountingKeys.bankTransactions.all;
    expect(bankingKeys.lines.list().slice(0, 2)).toEqual(bankTransactionsPrefix);
    expect(bankingKeys.lines.suggestions('bt_1').slice(0, 2)).toEqual(bankTransactionsPrefix);
    expect(bankingKeys.importPreview(['x']).slice(0, 2)).toEqual(bankTransactionsPrefix);
  });
});

describe('contentKey', () => {
  it('is stable for the same file and different for another one', () => {
    expect(contentKey('Date,Amount\n01/05/2026,1.00')).toBe(contentKey('Date,Amount\n01/05/2026,1.00'));
    expect(contentKey('Date,Amount\n01/05/2026,1.00')).not.toBe(contentKey('Date,Amount\n01/05/2026,2.00'));
    expect(contentKey('')).toBe('0:811c9dc5');
  });
});

describe('useBankImportPreview', () => {
  beforeEach(() => api.previewImport.mockReset());

  it('reads nothing until a file and a bank account are chosen', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useBankImportPreview(null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(api.previewImport).not.toHaveBeenCalled();
  });

  it('sends the file and the chosen CSV layout, and returns the preview', async () => {
    api.previewImport.mockResolvedValue({ data: { format: 'csv', needsCsvFormat: false, totalParsed: 2 } });
    const csvFormat = {
      dateFormat: 'MDY' as const,
      decimalSeparator: '.' as const,
      thousandsSeparator: ',' as const,
      negativeStyle: 'minus' as const,
      columns: { date: 'Date', description: 'Memo', amount: 'Amount' },
      hasHeader: true,
      skipRows: 0,
    };
    const input = { bankAccountId: 'ba_1', content: 'a,b\n1,2', fileName: 'a.csv', csvFormat };
    const { wrapper } = setup();
    const { result } = renderHook(() => useBankImportPreview(input), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual({ format: 'csv', needsCsvFormat: false, totalParsed: 2 }));
    expect(api.previewImport).toHaveBeenCalledWith(input);
  });

  it('keeps the previous preview while a changed layout is being read', async () => {
    api.previewImport.mockResolvedValueOnce({ data: { format: 'csv', needsCsvFormat: false, totalParsed: 1 } });
    const { wrapper } = setup();
    const base = { bankAccountId: 'ba_1', content: 'a,b', fileName: 'a.csv' };
    const { result, rerender } = renderHook(({ input }) => useBankImportPreview(input), {
      wrapper,
      initialProps: { input: base as Parameters<typeof useBankImportPreview>[0] },
    });
    await waitFor(() => expect(result.current.data?.totalParsed).toBe(1));

    api.previewImport.mockReturnValueOnce(new Promise(() => {}));
    rerender({ input: { ...base, format: 'csv' } });
    expect(result.current.data?.totalParsed).toBe(1);
    expect(result.current.isPlaceholderData).toBe(true);
  });
});

describe('useUndepositedPayments', () => {
  it('can be switched off for entities without Undeposited Funds', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useUndepositedPayments({ enabled: false }), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(api.listUndeposited).not.toHaveBeenCalled();
  });
});

describe('mutations refresh what they change', () => {
  beforeEach(() => Object.values(api).forEach((fn) => fn.mockReset()));

  it('an import refreshes bank lines and accounts, and the ledger for auto-reconciled lines', async () => {
    api.importStatement.mockResolvedValue({ data: { imported: 3 } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useImportBankStatement(), { wrapper });

    result.current.mutate({ bankAccountId: 'ba_1', fileName: 'a.csv', content: 'x' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidated()).toEqual(
      expect.arrayContaining([
        accountingKeys.bankTransactions.all,
        accountingKeys.bankAccounts.all,
        accountingKeys.payments.all,
        accountingKeys.journalEntries.all,
        accountingKeys.dashboard(),
      ]),
    );
  });

  it('making a deposit refreshes deposits, payments and the ledger', async () => {
    api.createDeposit.mockResolvedValue({ data: { id: 'dep_1', journalEntryId: 'je_1', amount: '10.00' } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useCreateBankDeposit(), { wrapper });

    result.current.mutate({ bankAccountId: 'ba_1', date: '2026-01-06', paymentIds: ['pay_1'] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ id: 'dep_1', journalEntryId: 'je_1', amount: '10.00' });
    expect(invalidated()).toEqual(
      expect.arrayContaining([bankingKeys.deposits.all, accountingKeys.payments.all, accountingKeys.accounts.all]),
    );
  });

  it('matching a payment refreshes bank lines and deposits', async () => {
    api.matchPayment.mockResolvedValue({ data: { id: 'bt_1', status: 'reconciled' } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useMatchBankLineToPayment(), { wrapper });

    result.current.mutate({ lineId: 'bt_1', paymentId: 'pay_1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.matchPayment).toHaveBeenCalledWith('bt_1', 'pay_1');
    expect(invalidated()).toEqual(expect.arrayContaining([accountingKeys.bankTransactions.all, bankingKeys.deposits.all]));
  });

  it('finishing a reconciliation refreshes its history and the ledger', async () => {
    api.completeReconciliation.mockResolvedValue({ data: { id: 'brec_1', status: 'completed' } });
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useCompleteBankReconciliation(), { wrapper });

    result.current.mutate({ id: 'brec_1', data: { clearedLineIds: ['jl_1'] } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.completeReconciliation).toHaveBeenCalledWith('brec_1', { clearedLineIds: ['jl_1'] });
    expect(invalidated()).toEqual(
      expect.arrayContaining([bankingKeys.reconciliations.all, accountingKeys.journalEntries.all]),
    );
  });

  it('saving progress puts the returned worksheet straight into the cache', async () => {
    const view = { id: 'brec_1', clearedLineIds: ['jl_1'] };
    api.saveReconciliationProgress.mockResolvedValue({ data: view });
    const { wrapper, client } = setup();
    const { result } = renderHook(() => useSaveBankReconciliationProgress(), { wrapper });

    result.current.mutate({ id: 'brec_1', data: { clearedLineIds: ['jl_1'] } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(bankingKeys.reconciliations.detail('brec_1'))).toEqual(view);
  });

  it('keeps a revealed account number out of the mutation cache', async () => {
    api.revealAccountNumber.mockResolvedValue({ data: { accountNumber: '001234567890' } });
    const { wrapper, client } = setup();
    const { result, unmount } = renderHook(() => useRevealAccountNumber(), { wrapper });

    result.current.mutate({ id: 'ba_1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    unmount();
    await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
  });
});
