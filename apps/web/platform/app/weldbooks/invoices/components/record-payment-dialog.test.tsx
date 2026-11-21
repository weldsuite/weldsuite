import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UsBankAccount } from '@/lib/api/domains/weldbooks-banking';

const jurisdiction = { code: 'US' as string | null };
const recordMutate = vi.fn();
const recordBillMutate = vi.fn();
const bankAccounts = { list: [] as UsBankAccount[] };
// Stable, like the real formatter's callbacks: the dialog resets its form when this changes.
const today = () => '2026-01-20';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ code: jurisdiction.code }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ today }),
}));
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: HrefLink };
});
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankAccounts: () => ({ data: { data: bankAccounts.list } }),
  useRecordInvoicePaymentWithTarget: () => ({ mutate: recordMutate, isPending: false }),
  useRecordBillPaymentWithTarget: () => ({ mutate: recordBillMutate, isPending: false }),
}));

import { RecordPaymentDialog } from './record-payment-dialog';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/banking/components/test-utils';

async function chooseMethod(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('combobox', { name: 'Payment method' }));
  await user.click(await screen.findByRole('option', { name }));
}

describe('RecordPaymentDialog', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    recordMutate.mockReset();
    recordBillMutate.mockReset();
    jurisdiction.code = 'US';
    bankAccounts.list = [
      { id: 'ba_1', name: 'Operating', accountType: 'checking', isActive: true, isDefault: true, accountNumberLast4: '7890' },
      { id: 'ba_2', name: 'Savings', accountType: 'savings', isActive: true, isDefault: false },
      { id: 'ba_card', name: 'Visa', accountType: 'credit_card', isActive: true },
    ] as UsBankAccount[];
  });

  const open = (target: { type: 'invoice' | 'bill'; id: string } = { type: 'invoice', id: 'inv_1' }) =>
    renderWithProviders(<RecordPaymentDialog target={target} balanceDue="1200.00" open onOpenChange={vi.fn()} />);

  it('lets a US entity choose where a received check goes, defaulting to Undeposited Funds', async () => {
    const user = userEvent.setup();
    open();
    await chooseMethod(user, 'Check');

    expect(screen.getByLabelText('Check number')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-to')).toHaveTextContent('Undeposited Funds');
    expect(screen.getByText('Held with other checks and cash until you make a bank deposit.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Check number'), '1042');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(recordMutate.mock.calls[0][0]).toEqual({
      id: 'inv_1',
      data: {
        amount: '1200.00',
        date: '2026-01-20',
        paymentMethod: 'check',
        checkNumber: '1042',
        reference: undefined,
        bankAccountId: undefined,
      },
    });
  });

  it('sends the bank account when the check goes straight into one', async () => {
    const user = userEvent.setup();
    open();
    await chooseMethod(user, 'Cash');

    await user.click(screen.getByTestId('deposit-to'));
    expect(screen.queryByRole('option', { name: /Visa/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'Operating · •••• 7890' }));
    expect(screen.getByText('Debits this bank account right away.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(recordMutate.mock.calls[0][0].data).toMatchObject({ paymentMethod: 'cash', bankAccountId: 'ba_1' });
  });

  it('always asks where the money goes: an ACH payment defaults to the default bank account', async () => {
    const user = userEvent.setup();
    open();
    await chooseMethod(user, 'ACH');

    expect(screen.getByTestId('deposit-to')).toHaveTextContent('Operating');
    await user.click(screen.getByTestId('deposit-to'));
    // No Undeposited Funds for a payment that is not a check or cash, and no credit card to deposit into.
    expect(screen.queryByRole('option', { name: 'Undeposited Funds' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Visa/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(recordMutate.mock.calls[0][0].data).toMatchObject({ paymentMethod: 'ach', bankAccountId: 'ba_1' });
  });

  it('sends the bank account that was picked instead of the default one', async () => {
    const user = userEvent.setup();
    open();
    await chooseMethod(user, 'ACH');
    await user.click(screen.getByTestId('deposit-to'));
    await user.click(await screen.findByRole('option', { name: 'Savings' }));
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(recordMutate.mock.calls[0][0].data).toMatchObject({ bankAccountId: 'ba_2' });
  });

  it('takes the first bank account when none is the default', async () => {
    bankAccounts.list = bankAccounts.list.map((account) => ({ ...account, isDefault: false }));
    const user = userEvent.setup();
    open();
    await chooseMethod(user, 'ACH');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(recordMutate.mock.calls[0][0].data).toMatchObject({ bankAccountId: 'ba_1' });
  });

  it('has no check method for a Dutch entity, and cash goes to a bank account', async () => {
    jurisdiction.code = 'NL';
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('combobox', { name: 'Payment method' }));
    expect(screen.queryByRole('option', { name: 'Check' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'Cash' }));
    expect(screen.getByTestId('deposit-to')).toHaveTextContent('Operating');
    await user.click(screen.getByTestId('deposit-to'));
    expect(screen.queryByRole('option', { name: 'Undeposited Funds' })).not.toBeInTheDocument();
  });

  it('says the payment books to the default bank ledger account when there is no bank account, with a link to add one', async () => {
    bankAccounts.list = [];
    const user = userEvent.setup();
    open();
    await chooseMethod(user, 'ACH');

    expect(screen.queryByTestId('deposit-to')).not.toBeInTheDocument();
    expect(screen.getByTestId('no-bank-account-hint')).toHaveTextContent('booked to your default bank ledger account');
    expect(screen.getByRole('link', { name: 'Add a bank account' })).toHaveAttribute('href', '/weldbooks/banking');

    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(recordMutate.mock.calls[0][0].data.bankAccountId).toBeUndefined();
  });

  it('records a payment against a bill with the bill endpoint, paid from a bank account', async () => {
    const user = userEvent.setup();
    open({ type: 'bill', id: 'bil_1' });

    expect(screen.getByText('Pay from')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Reference (optional)'), 'INV-77');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));

    expect(recordMutate).not.toHaveBeenCalled();
    expect(recordBillMutate.mock.calls[0][0]).toEqual({
      id: 'bil_1',
      data: {
        amount: '1200.00',
        date: '2026-01-20',
        paymentMethod: expect.any(String),
        reference: 'INV-77',
        bankAccountId: 'ba_1',
      },
    });
  });

  it('offers no Undeposited Funds and no check number on a bill, even for a check', async () => {
    const user = userEvent.setup();
    open({ type: 'bill', id: 'bil_1' });
    await chooseMethod(user, 'Check');

    expect(screen.queryByLabelText('Check number')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('deposit-to'));
    expect(screen.queryByRole('option', { name: 'Undeposited Funds' })).not.toBeInTheDocument();
  });
});
