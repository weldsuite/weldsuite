import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UsBankAccount } from '@/lib/api/domains/weldbooks-banking';

const jurisdiction = { code: 'US' as string | null };
const createMutate = vi.fn();
const updateMutate = vi.fn();

vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ code: jurisdiction.code }),
}));
vi.mock('@/hooks/use-current-entity-currency', () => ({
  useCurrentEntityCurrency: () => ({ entityCurrency: jurisdiction.code === 'US' ? 'USD' : 'EUR' }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccounts: () => ({
    data: {
      data: [
        { id: 'acc_checking', code: '1000', name: 'Checking', type: 'asset', subtype: 'bank', isActive: true },
        { id: 'acc_card', code: '2100', name: 'Credit Card Payable', type: 'liability', subtype: 'credit_card', isActive: true },
      ],
    },
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useCreateBankAccountWithDetails: () => ({ mutate: createMutate, isPending: false, error: null }),
  useUpdateBankAccountWithDetails: () => ({ mutate: updateMutate, isPending: false, error: null }),
}));

import { BankAccountFormDialog } from './bank-account-form-dialog';
import { polyfillRadixSelect, renderWithProviders } from './test-utils';

/** JPMorgan Chase's routing number: nine digits that pass the ABA check. */
const VALID_ROUTING = '021000021';

describe('BankAccountFormDialog', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    createMutate.mockReset();
    updateMutate.mockReset();
    jurisdiction.code = 'US';
  });

  it('asks a US entity for account type, routing and account number instead of IBAN and BIC', () => {
    renderWithProviders(<BankAccountFormDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByTestId('bank-account-type')).toBeInTheDocument();
    expect(screen.getByLabelText('Routing number')).toBeInTheDocument();
    expect(screen.getByLabelText('Account number')).toBeInTheDocument();
    expect(screen.getByLabelText('Next check number')).toBeInTheDocument();
    expect(screen.queryByLabelText(/IBAN/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/BIC/)).not.toBeInTheDocument();
  });

  it('keeps the IBAN and BIC form, and no US fields, for a Dutch entity', () => {
    jurisdiction.code = 'NL';
    renderWithProviders(<BankAccountFormDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText(/IBAN/)).toBeInTheDocument();
    expect(screen.getByLabelText(/BIC/)).toBeInTheDocument();
    expect(screen.queryByTestId('bank-account-type')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Routing number')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Next check number')).not.toBeInTheDocument();
  });

  it('refuses a routing number that fails the ABA check and creates nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BankAccountFormDialog open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText('Name'), 'Operating');
    await user.type(screen.getByLabelText('Routing number'), '123456789');
    await user.click(screen.getByRole('button', { name: 'Create bank account' }));

    expect(await screen.findByText('This routing number does not pass the ABA check. Check the nine digits.')).toBeInTheDocument();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('sends the US fields, and creates the ledger account by default', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BankAccountFormDialog open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText('Name'), 'Operating');
    await user.type(screen.getByLabelText('Routing number'), VALID_ROUTING);
    await user.type(screen.getByLabelText('Account number'), '0012 3456 7890');
    await user.type(screen.getByLabelText('Next check number'), '1001');
    await user.click(screen.getByRole('button', { name: 'Create bank account' }));

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toEqual({
      name: 'Operating',
      currency: 'USD',
      isDefault: false,
      autoReconcile: true,
      accountType: 'checking',
      nextCheckNumber: 1001,
      routingNumber: VALID_ROUTING,
      accountNumber: '001234567890',
    });
  });

  it('labels a credit card as a liability and drops the routing number and checks', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BankAccountFormDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getByTestId('bank-account-type'));
    await user.click(await screen.findByRole('option', { name: 'Credit card' }));

    expect(screen.getByTestId('bank-account-liability-note')).toHaveTextContent('liabilities');
    expect(screen.queryByLabelText('Routing number')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Next check number')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Card number')).toBeInTheDocument();
  });

  it('shows only the last four digits of a stored account number when editing', () => {
    const account = {
      id: 'ba_1',
      name: 'Operating',
      iban: null,
      bankName: null,
      currentBalance: '0',
      currency: 'USD',
      isActive: true,
      accountType: 'checking',
      routingNumber: VALID_ROUTING,
      accountNumberLast4: '7890',
      hasAccountNumber: true,
      ledgerAccountId: 'acc_checking',
    } as UsBankAccount;
    renderWithProviders(<BankAccountFormDialog open onOpenChange={vi.fn()} bankAccount={account} />);

    expect(screen.getByTestId('stored-account-number')).toHaveTextContent('•••• 7890');
    expect(screen.getByLabelText('Routing number')).toHaveValue(VALID_ROUTING);
    expect(screen.queryByLabelText('Account number')).not.toBeInTheDocument();
  });

  it('removes a stored account number only when asked to', async () => {
    const user = userEvent.setup();
    const account = {
      id: 'ba_1',
      name: 'Operating',
      iban: null,
      bankName: null,
      currentBalance: '0',
      currency: 'USD',
      isActive: true,
      accountType: 'checking',
      routingNumber: VALID_ROUTING,
      accountNumberLast4: '7890',
      hasAccountNumber: true,
      ledgerAccountId: 'acc_checking',
    } as UsBankAccount;
    renderWithProviders(<BankAccountFormDialog open onOpenChange={vi.fn()} bankAccount={account} />);

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(updateMutate.mock.calls[0][0].data).not.toHaveProperty('accountNumber');
    expect(updateMutate.mock.calls[0][0].data).toMatchObject({ routingNumber: VALID_ROUTING, accountType: 'checking' });

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(updateMutate.mock.calls[1][0].data).toHaveProperty('accountNumber', null);
  });
});
