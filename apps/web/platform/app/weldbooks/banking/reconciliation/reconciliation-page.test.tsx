import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BankLine, MatchSuggestion, UsBankAccount } from '@/lib/api/domains/weldbooks-banking';

const matchPaymentMutate = vi.fn();
const matchDepositMutate = vi.fn();
const reconcileMutate = vi.fn();
const permissions = new Set(['banking:update']);
const jurisdiction = { code: 'US' as string | null };

const lines = [
  { id: 'bt_1', bankAccountId: 'ba_1', date: '2026-01-07', description: 'CHECK 1042', amount: '-300.05', counterpartyName: null, status: 'unreconciled', checkNumber: '1042', source: 'feed' },
  { id: 'bt_2', bankAccountId: 'ba_1', date: '2026-01-08', description: 'DEPOSIT', amount: '1550.50', counterpartyName: null, status: 'unreconciled', checkNumber: null, source: 'import' },
] as BankLine[];

const suggestionsByLine: Record<string, MatchSuggestion[]> = {
  bt_1: [{ type: 'payment', id: 'pay_1', number: '1042', contactName: 'Bolt', amount: '300.05', confidence: 0.9, reasons: ['check number matches'] }],
  bt_2: [
    { type: 'deposit', id: 'dep_1', number: 'January checks', contactName: null, amount: '1550.50', confidence: 0.75, reasons: ['deposit total matches'] },
    { type: 'invoice', id: 'inv_1', number: 'INV-1', contactName: 'Acme', amount: '1550.50', confidence: 0.5, reasons: ['exact amount match'] },
  ],
};

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ code: jurisdiction.code }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    currency: 'USD',
  }),
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: {} }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({ useAccountingAccounts: () => ({ data: { data: [] } }) }));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useMutation: () => ({ mutate: reconcileMutate, isPending: false, isSuccess: false, error: null, data: undefined }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankAccounts: () => ({
    data: { data: [{ id: 'ba_1', name: 'Operating', iban: null, accountNumberLast4: '7890', currency: 'USD' }] as UsBankAccount[] },
  }),
  useBankLines: (filters?: { bankAccountId?: string }) => ({ data: filters ? { data: lines } : undefined, isLoading: false }),
  useBankLineSuggestions: (id: string | null) => ({ data: id ? suggestionsByLine[id] : [] }),
  useMatchBankLineToPayment: () => ({ mutate: matchPaymentMutate, isPending: false, error: null }),
  useMatchBankLineToDeposit: () => ({ mutate: matchDepositMutate, isPending: false, error: null }),
}));

import BankReconciliationPage from './page';
import { polyfillRadixSelect, renderWithProviders } from '../components/test-utils';

async function chooseAccount() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name: /Operating/ }));
  return user;
}

describe('Bank reconciliation page', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    matchPaymentMutate.mockReset();
    matchDepositMutate.mockReset();
    reconcileMutate.mockReset();
    permissions.clear();
    permissions.add('banking:update');
    jurisdiction.code = 'US';
  });

  it('shows the check number and the source of each bank line', async () => {
    renderWithProviders(<BankReconciliationPage />);
    await chooseAccount();

    expect(screen.getByText('Check #1042')).toBeInTheDocument();
    expect(screen.getByText('Bank feed')).toBeInTheDocument();
    expect(screen.getByText('File import')).toBeInTheDocument();
  });

  it('matches a bank line to a payment that is already recorded', async () => {
    renderWithProviders(<BankReconciliationPage />);
    const user = await chooseAccount();

    await user.click(screen.getByText('CHECK 1042'));
    const suggestion = await screen.findByTestId('suggestion-payment');
    expect(within(suggestion).getByText('Check number matches')).toBeInTheDocument();
    await user.click(screen.getByTestId('match-payment'));

    expect(matchPaymentMutate.mock.calls[0][0]).toEqual({ lineId: 'bt_1', paymentId: 'pay_1' });
    expect(matchDepositMutate).not.toHaveBeenCalled();
    expect(reconcileMutate).not.toHaveBeenCalled();
  });

  it('matches a deposit line to the bank deposit, and an invoice through the existing reconcile flow', async () => {
    renderWithProviders(<BankReconciliationPage />);
    const user = await chooseAccount();

    await user.click(screen.getByText('DEPOSIT'));
    await user.click(await screen.findByTestId('match-deposit'));
    expect(matchDepositMutate.mock.calls[0][0]).toEqual({ lineId: 'bt_2', depositId: 'dep_1' });

    await user.click(screen.getByTestId('match-invoice'));
    expect(reconcileMutate.mock.calls[0][0]).toEqual({ txnId: 'bt_2', data: { type: 'invoice', entityId: 'inv_1' } });
  });

  it('offers the statement reconciliation to US entities only', async () => {
    const { unmount } = renderWithProviders(<BankReconciliationPage />);
    expect(screen.getByRole('link', { name: /Reconcile statement/ })).toHaveAttribute('href', '/weldbooks/banking/statements');
    unmount();

    jurisdiction.code = 'NL';
    renderWithProviders(<BankReconciliationPage />);
    expect(screen.queryByRole('link', { name: /Reconcile statement/ })).not.toBeInTheDocument();
  });

  it('cannot match without banking:update', async () => {
    permissions.clear();
    renderWithProviders(<BankReconciliationPage />);
    const user = await chooseAccount();
    await user.click(screen.getByText('CHECK 1042'));
    expect(await screen.findByTestId('match-payment')).toBeDisabled();
  });
});
