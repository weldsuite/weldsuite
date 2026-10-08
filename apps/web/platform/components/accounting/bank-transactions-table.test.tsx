import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { BankLine } from '@/lib/api/domains/weldbooks-banking';

vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    currency: 'USD',
    entityLocale: 'en-US',
    formatDate: (value: string) => value,
  }),
}));

import { BankTransactionsTable } from './bank-transactions-table';
import { renderWithProviders } from '@/app/weldbooks/banking/components/test-utils';

const line = (overrides: Partial<BankLine>): BankLine =>
  ({
    id: 'bt_1',
    bankAccountId: 'ba_1',
    date: '2026-01-07',
    description: 'CHECK 1042',
    amount: '-300.05',
    counterpartyName: null,
    counterpartyIban: null,
    reference: null,
    status: 'unreconciled',
    ...overrides,
  }) as BankLine;

describe('BankTransactionsTable', () => {
  it('shows the check number and where each line came from', () => {
    renderWithProviders(
      <BankTransactionsTable
        transactions={[
          line({ id: 'bt_1', checkNumber: '1042', source: 'feed' }),
          line({ id: 'bt_2', description: 'Deposit', amount: '500.00', source: 'import' }),
          line({ id: 'bt_3', description: 'Cash sale', amount: '20.00', source: 'manual' }),
        ]}
      />,
    );

    expect(screen.getByText('Check #')).toBeInTheDocument();
    expect(screen.getByText('1042')).toBeInTheDocument();
    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByText('Bank feed')).toBeInTheDocument();
    expect(screen.getByText('File import')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });

  it('leaves both columns out for lines that carry neither', () => {
    renderWithProviders(<BankTransactionsTable transactions={[line({ id: 'bt_1' })]} />);

    expect(screen.getByText('CHECK 1042')).toBeInTheDocument();
    expect(screen.queryByText('Check #')).not.toBeInTheDocument();
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
  });
});
