import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UsBankAccount } from '@/lib/api/domains/weldbooks-banking';

const jurisdiction = { code: 'US' as string | null };
const recordMutate = vi.fn();
// Stable, like the real formatter's callbacks: the dialog resets its form when this changes.
const today = () => '2026-01-20';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ code: jurisdiction.code }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ today }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankAccounts: () => ({
    data: {
      data: [
        { id: 'ba_1', name: 'Operating', accountType: 'checking', isActive: true, accountNumberLast4: '7890' },
        { id: 'ba_card', name: 'Visa', accountType: 'credit_card', isActive: true },
      ] as UsBankAccount[],
    },
  }),
  useRecordInvoicePaymentWithTarget: () => ({ mutate: recordMutate, isPending: false }),
}));

import { RecordPaymentDialog } from './record-payment-dialog';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/banking/components/test-utils';

async function chooseMethod(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('combobox', { name: 'Payment Method' }));
  await user.click(await screen.findByRole('option', { name }));
}

describe('RecordPaymentDialog', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    recordMutate.mockReset();
    jurisdiction.code = 'US';
  });

  const open = () => renderWithProviders(<RecordPaymentDialog invoiceId="inv_1" balanceDue="1200.00" open onOpenChange={vi.fn()} />);

  it('lets a US entity choose where a received check goes, defaulting to Undeposited Funds', async () => {
    const user = userEvent.setup();
    open();
    await chooseMethod(user, 'Check');

    expect(screen.getByLabelText('Check number')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-to')).toHaveTextContent('Undeposited Funds');
    expect(screen.getByText('Held with other checks and cash until you make a bank deposit.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Check number'), '1042');
    await user.click(screen.getByRole('button', { name: 'Record Payment' }));
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

    await user.click(screen.getByRole('button', { name: 'Record Payment' }));
    expect(recordMutate.mock.calls[0][0].data).toMatchObject({ paymentMethod: 'cash', bankAccountId: 'ba_1' });
  });

  it('has no deposit choice for an ACH payment', async () => {
    const user = userEvent.setup();
    open();
    await chooseMethod(user, 'ACH');
    expect(screen.queryByTestId('deposit-to')).not.toBeInTheDocument();
  });

  it('has no deposit choice, and no check method, for a Dutch entity', async () => {
    jurisdiction.code = 'NL';
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('combobox', { name: 'Payment Method' }));
    expect(screen.queryByRole('option', { name: 'Check' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'Cash' }));
    expect(screen.queryByTestId('deposit-to')).not.toBeInTheDocument();
  });
});
