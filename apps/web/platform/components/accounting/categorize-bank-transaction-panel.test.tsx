import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  CategorizeBankTransactionPanel,
  ledgerCategoryAccounts,
} from './categorize-bank-transaction-panel';
import type { Account } from '@/lib/api/domains/weldbooks';

const labels = {
  title: 'Not an invoice?',
  hint: 'Pick a ledger account.',
  accountLabel: 'Post to account',
  accountPlaceholder: 'Select account',
  button: 'Categorize',
  examples: 'Other income, Bank fees.',
};

function account(partial: Partial<Account> & { id: string; code: string; name: string; type: string }): Account {
  return {
    description: null,
    subtype: null,
    parentAccountId: null,
    currency: 'EUR',
    isActive: true,
    isSystemAccount: false,
    openingBalance: '0',
    currentBalance: '0',
    normalSide: 'credit',
    ...partial,
  };
}

describe('ledgerCategoryAccounts', () => {
  it('keeps revenue, expense, and equity accounts and drops bank assets', () => {
    const accounts = [
      account({ id: 'a_bank', code: '1100', name: 'Bank', type: 'asset' }),
      account({ id: 'a_income', code: '8100', name: 'Other income', type: 'revenue' }),
      account({ id: 'a_fees', code: '4650', name: 'Bank fees', type: 'expense' }),
      account({ id: 'a_equity', code: '0540', name: 'Owner', type: 'equity' }),
      account({ id: 'a_inactive', code: '8110', name: 'Old', type: 'revenue', isActive: false }),
    ];
    expect(ledgerCategoryAccounts(accounts).map((a) => a.id)).toEqual([
      'a_equity',
      'a_fees',
      'a_income',
    ]);
  });
});

describe('CategorizeBankTransactionPanel', () => {
  it('keeps Categorize disabled until an account is chosen', () => {
    const onCategorize = vi.fn();
    render(
      <CategorizeBankTransactionPanel
        accounts={[
          account({ id: 'acc_other', code: '8100', name: 'Other income', type: 'revenue' }),
        ]}
        labels={labels}
        onCategorize={onCategorize}
      />,
    );

    expect(screen.getByText('Not an invoice?')).toBeInTheDocument();
    expect(screen.getByTestId('categorize-transaction')).toBeDisabled();
    expect(onCategorize).not.toHaveBeenCalled();
  });
});
