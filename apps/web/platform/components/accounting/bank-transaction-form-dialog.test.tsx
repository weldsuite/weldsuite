import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BankTransactionFormDialog } from './bank-transaction-form-dialog';

const mutate = vi.fn();

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (path: string) => path,
}));

vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingBankAccounts: () => ({
    data: { data: [{ id: 'ba_1', name: 'Checking', iban: 'NL00TEST' }] },
  }),
  useCreateBankTransaction: () => ({
    mutate,
    isPending: false,
    error: null,
  }),
}));

describe('BankTransactionFormDialog', () => {
  beforeEach(() => {
    mutate.mockReset();
  });

  it('disables submit until an amount is entered', () => {
    render(
      <BankTransactionFormDialog open onOpenChange={() => {}} bankAccountId="ba_1" />,
    );

    expect(screen.getByText('sweep.weldbooks.bankTransactionForm.title')).toBeInTheDocument();
    expect(screen.getByTestId('submit-bank-transaction')).toBeDisabled();
  });

  it('submits a signed money-in amount against the locked bank account', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <BankTransactionFormDialog open onOpenChange={onOpenChange} bankAccountId="ba_1" />,
    );

    await user.type(screen.getByLabelText('sweep.weldbooks.bankTransactionForm.amountLabel'), '50.25');
    await user.type(
      screen.getByLabelText('sweep.weldbooks.bankTransactionForm.descriptionLabel'),
      'Client payment',
    );
    await user.click(screen.getByTestId('submit-bank-transaction'));

    expect(mutate).toHaveBeenCalledTimes(1);
    const payload = mutate.mock.calls[0][0] as { bankAccountId: string; amount: number; description: string };
    expect(payload.bankAccountId).toBe('ba_1');
    expect(payload.amount).toBe(50.25);
    expect(payload.description).toBe('Client payment');
  });
});
