import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UndepositedPayment, UsBankAccount } from '@/lib/api/domains/weldbooks-banking';

const createMutate = vi.fn();
const navigate = vi.fn();
const permissions = new Set(['banking:create']);

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => navigate,
  useSearch: () => ({}),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    today: () => '2026-01-20',
    entityCurrency: 'USD',
  }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccounts: () => ({
    data: {
      data: [
        { id: 'acc_check', code: '1000', name: 'Checking', type: 'asset', subtype: 'bank', isActive: true },
        { id: 'acc_ufunds', code: '1050', name: 'Undeposited funds', type: 'asset', isActive: true, systemRole: 'undeposited_funds' },
        { id: 'acc_income', code: '4900', name: 'Other income', type: 'revenue', isActive: true },
      ],
    },
  }),
}));

const payments: UndepositedPayment[] = [
  { paymentId: 'pay_1', date: '2026-01-05', paymentMethod: 'check', checkNumber: '1001', reference: null, currency: 'USD', paymentAmount: '1200.00', amount: 1200, contactId: 'c1', contactName: 'Acme', journalEntryId: 'je1' },
  { paymentId: 'pay_2', date: '2026-01-06', paymentMethod: 'cash', checkNumber: null, reference: null, currency: 'USD', paymentAmount: '350.50', amount: 350.5, contactId: 'c2', contactName: 'Bolt', journalEntryId: 'je2' },
];
const accounts = [
  { id: 'ba_1', name: 'Operating', accountType: 'checking', isActive: true, isDefault: true, ledgerAccountId: 'acc_check', accountNumberLast4: '7890' },
  { id: 'ba_card', name: 'Visa', accountType: 'credit_card', isActive: true, ledgerAccountId: 'acc_card' },
] as UsBankAccount[];

vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useUndepositedPayments: () => ({ data: payments, isLoading: false, isError: false }),
  useBankAccounts: () => ({ data: { data: accounts }, isLoading: false }),
  useCreateBankDeposit: () => ({ mutate: createMutate, isPending: false, isError: false, error: null }),
}));

import MakeDepositPage from './new/page';
import { polyfillRadixSelect, renderWithProviders } from '../banking/components/test-utils';

describe('Make deposit page', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    createMutate.mockReset();
    navigate.mockReset();
    permissions.clear();
    permissions.add('banking:create');
  });

  it('adds the selected payments and the other lines into the deposit total', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MakeDepositPage />);

    expect(screen.getByTestId('deposit-total')).toHaveTextContent('$0.00');
    await user.click(screen.getByTestId('select-payment-pay_1'));
    expect(screen.getByTestId('deposit-total')).toHaveTextContent('$1200.00');
    await user.click(screen.getByTestId('select-payment-pay_2'));
    expect(screen.getByTestId('payments-total')).toHaveTextContent('$1550.50');

    // Cash back reduces the deposit.
    await user.click(screen.getByTestId('add-other-line'));
    await user.type(screen.getByTestId('other-line-amount'), '-50');
    expect(screen.getByTestId('other-total')).toHaveTextContent('$-50.00');
    expect(screen.getByTestId('deposit-total')).toHaveTextContent('$1500.50');
  });

  it('selects and clears every payment at once', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MakeDepositPage />);

    await user.click(screen.getByTestId('select-all-payments'));
    expect(screen.getByTestId('deposit-total')).toHaveTextContent('$1550.50');
    await user.click(screen.getByTestId('select-all-payments'));
    expect(screen.getByTestId('deposit-total')).toHaveTextContent('$0.00');
  });

  it('starts on the default bank account and offers no credit card to deposit into', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MakeDepositPage />);

    expect(screen.getByTestId('deposit-bank-account')).toHaveTextContent('Operating · •••• 7890');
    await user.click(screen.getByTestId('deposit-bank-account'));
    expect(screen.queryByRole('option', { name: /Visa/ })).not.toBeInTheDocument();
  });

  it('does not offer Undeposited Funds or the bank itself for an other line', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MakeDepositPage />);

    await user.click(screen.getByTestId('add-other-line'));
    await user.click(screen.getByRole('combobox', { name: 'Account' }));
    expect(await screen.findByRole('option', { name: /4900 — Other income/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Undeposited funds/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /1000 — Checking/ })).not.toBeInTheDocument();
  });

  it('makes the deposit with the chosen payments and goes to it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MakeDepositPage />);

    await user.click(screen.getByTestId('select-payment-pay_1'));
    await user.type(screen.getByLabelText('Memo'), 'Jan checks');
    await user.click(screen.getByTestId('make-deposit'));

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toEqual({
      bankAccountId: 'ba_1',
      date: '2026-01-20',
      paymentIds: ['pay_1'],
      memo: 'Jan checks',
    });
    createMutate.mock.calls[0][1].onSuccess({ id: 'dep_9' });
    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/deposits/$id', params: { id: 'dep_9' } });
  });

  it('explains what is missing instead of submitting an empty deposit', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MakeDepositPage />);

    await user.click(screen.getByTestId('make-deposit'));
    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Select at least one payment, or add another line.');
  });

  it('is read-only without banking:create', () => {
    permissions.clear();
    renderWithProviders(<MakeDepositPage />);
    expect(screen.getByTestId('make-deposit')).toBeDisabled();
    expect(screen.getByText('You need permission to make deposits.')).toBeInTheDocument();
  });
});
