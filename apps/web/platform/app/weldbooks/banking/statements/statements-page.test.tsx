import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReconciliationHistoryRow, UsBankAccount } from '@/lib/api/domains/weldbooks-banking';

const startMutate = vi.fn();
const undoMutateAsync = vi.fn();
const navigate = vi.fn();
const permissions = new Set(['banking:create', 'banking:update', 'banking:manage']);
const history: { rows: ReconciliationHistoryRow[] } = { rows: [] };
const accounts: UsBankAccount[] = [
  { id: 'ba_1', name: 'Operating', iban: null, bankName: null, currentBalance: '0', currency: 'USD', isActive: true, accountType: 'checking', accountNumberLast4: '7890' } as UsBankAccount,
  { id: 'ba_card', name: 'Visa', iban: null, bankName: null, currentBalance: '0', currency: 'USD', isActive: true, accountType: 'credit_card' } as UsBankAccount,
];

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => navigate,
  useSearch: () => ({}),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
const today = () => '2026-02-28';
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string | undefined) => value ?? '',
    formatDateTime: (value: string) => value,
    today,
    entityCurrency: 'USD',
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankAccounts: () => ({ data: { data: accounts }, isLoading: false }),
  useBankReconciliations: () => ({ data: { data: history.rows }, isLoading: false }),
  useStartBankReconciliation: () => ({ mutate: startMutate, reset: vi.fn(), isPending: false, isError: false, error: null }),
  useUndoBankReconciliation: () => ({ mutateAsync: undoMutateAsync, isError: false, error: null }),
  useDiscardBankReconciliation: () => ({ mutateAsync: vi.fn() }),
}));

import StatementReconciliationsPage from './page';
import { polyfillRadixSelect, renderWithProviders } from '../components/test-utils';

const row = (id: string, status: ReconciliationHistoryRow['status'], statementDate: string, endingBalance = '1000.00'): ReconciliationHistoryRow => ({
  id,
  bankAccountId: 'ba_1',
  ledgerAccountId: 'acc_1',
  statementDate,
  beginningBalance: '0.00',
  statementEndingBalance: endingBalance,
  clearedBalance: status === 'in_progress' ? null : endingBalance,
  difference: status === 'in_progress' ? null : '0.00',
  status,
  adjustmentJournalEntryId: null,
  completedAt: status === 'completed' ? `${statementDate}T10:00:00Z` : null,
  completedBy: null,
  undoneAt: null,
  createdAt: `${statementDate}T09:00:00Z`,
  hasReport: status !== 'in_progress',
});

describe('Statement reconciliation page', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    startMutate.mockReset();
    undoMutateAsync.mockReset();
    navigate.mockReset();
    permissions.clear();
    ['banking:create', 'banking:update', 'banking:manage'].forEach((p) => permissions.add(p));
    history.rows = [];
  });

  it('asks for the beginning balance on the first reconciliation of an account', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StatementReconciliationsPage />);

    expect(screen.getByTestId('statement-beginning-balance')).toHaveValue('0.00');
    await user.clear(screen.getByTestId('statement-beginning-balance'));
    await user.type(screen.getByTestId('statement-beginning-balance'), '500');
    await user.type(screen.getByTestId('statement-ending-balance'), '1,350.05');
    await user.click(screen.getByTestId('start-reconciliation'));

    expect(startMutate.mock.calls[0][0]).toEqual({
      bankAccountId: 'ba_1',
      statementDate: '2026-02-28',
      statementEndingBalance: 1350.05,
      beginningBalance: 500,
    });
    startMutate.mock.calls[0][1].onSuccess({ id: 'brec_9' });
    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/banking/statements/$id', params: { id: 'brec_9' } });
  });

  it('begins where the last reconciled statement ended and refuses an earlier statement date', async () => {
    history.rows = [row('r1', 'completed', '2026-01-31', '1200.00')];
    const user = userEvent.setup();
    renderWithProviders(<StatementReconciliationsPage />);

    expect(screen.queryByTestId('statement-beginning-balance')).not.toBeInTheDocument();
    expect(screen.getByTestId('statement-beginning-fixed')).toHaveTextContent('$1200.00');

    await user.type(screen.getByTestId('statement-ending-balance'), '1500');
    await user.click(screen.getByTestId('start-reconciliation'));
    expect(startMutate.mock.calls[0][0]).toEqual({ bankAccountId: 'ba_1', statementDate: '2026-02-28', statementEndingBalance: 1500 });
  });

  it('does not start without a usable ending balance', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StatementReconciliationsPage />);
    await user.click(screen.getByTestId('start-reconciliation'));
    expect(startMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the statement date and ending balance as numbers.');
  });

  it('offers to resume the reconciliation in progress instead of starting another', () => {
    history.rows = [row('r2', 'in_progress', '2026-02-28'), row('r1', 'completed', '2026-01-31')];
    renderWithProviders(<StatementReconciliationsPage />);

    expect(screen.getByTestId('in-progress')).toHaveTextContent('A reconciliation for the statement dated 2026-02-28 is in progress.');
    expect(screen.queryByTestId('start-reconciliation')).not.toBeInTheDocument();
  });

  it('can undo only the latest completed reconciliation, and only with banking:manage', async () => {
    history.rows = [row('r2', 'completed', '2026-02-28'), row('r1', 'completed', '2026-01-31')];
    const { unmount } = renderWithProviders(<StatementReconciliationsPage />);
    expect(screen.getAllByTestId('undo-reconciliation')).toHaveLength(1);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('undo-reconciliation'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Undo' }));
    expect(undoMutateAsync).toHaveBeenCalledWith('r2');
    unmount();

    permissions.delete('banking:manage');
    renderWithProviders(<StatementReconciliationsPage />);
    expect(screen.queryByTestId('undo-reconciliation')).not.toBeInTheDocument();
  });

  it('uses balance owed wording for a credit card', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StatementReconciliationsPage />);
    await user.click(screen.getByTestId('statement-account'));
    await user.click(await screen.findByRole('option', { name: 'Visa' }));
    expect(screen.getByText('Statement balance owed')).toBeInTheDocument();
    expect(screen.getByText('Beginning balance owed')).toBeInTheDocument();
  });
});
