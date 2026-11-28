import { beforeAll, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BankLine } from '@/lib/api/domains/weldbooks-banking';
import { polyfillRadixSelect, renderWithProviders } from '../../invoices/components/test-utils';
import { TransferForm } from './transfer-form';

const accounts = [
  { id: 'ba_1', name: 'Business', iban: 'NL91ABNA0417164300', accountType: 'checking' },
  { id: 'ba_2', name: 'Savings', iban: 'NL02ABNA0123456789', accountType: 'savings' },
  { id: 'ba_mollie', name: 'Mollie', iban: null, accountType: 'payment_provider' },
];

const line = (overrides: Partial<BankLine> = {}) =>
  ({ id: 'bl_1', bankAccountId: 'ba_1', amount: '-10.00', date: '2026-11-25', status: 'unreconciled', ...overrides }) as BankLine;

function renderForm(l: BankLine) {
  return renderWithProviders(
    <TransferForm line={l} accounts={accounts} pending={false} errorMessage={null} onSubmit={vi.fn()} onCancel={vi.fn()} />,
  );
}

async function optionsOf() {
  await userEvent.click(screen.getByRole('combobox'));
  const list = await screen.findByRole('listbox');
  return within(list)
    .getAllByRole('option')
    .map((option) => option.textContent);
}

describe('TransferForm', () => {
  beforeAll(polyfillRadixSelect);

  it('does not offer the Mollie account as an own account for a regular line', async () => {
    renderForm(line({ counterpartyName: 'Savings' }));
    expect(await optionsOf()).toEqual(['Savings']);
  });

  it('offers the Mollie account, labelled as a payment provider, for a payout line', async () => {
    renderForm(line({ counterpartyName: 'Mollie Payments' }));
    expect(await optionsOf()).toEqual(['Savings', 'Mollie (payment provider)']);
  });
});
