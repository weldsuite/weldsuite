import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReconciliationLine, ReconciliationView } from '@/lib/api/domains/weldbooks-banking';

const view: { current: ReconciliationView } = { current: undefined as unknown as ReconciliationView };
const completeMutate = vi.fn();
const saveMutate = vi.fn();
const navigate = vi.fn();
const permissions = new Set(['banking:update']);

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useParams: () => ({ id: 'brec_1' }),
  useNavigate: () => navigate,
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    entityCurrency: 'USD',
  }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccounts: () => ({
    data: { data: [{ id: 'acc_fees', code: '6150', name: 'Bank fees', type: 'expense', isActive: true }] },
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankReconciliation: () => ({ data: view.current, isLoading: false, isError: false }),
  useSaveBankReconciliationProgress: () => ({ mutate: saveMutate, isPending: false, isError: false, error: null }),
  useCompleteBankReconciliation: () => ({ mutate: completeMutate, isPending: false, isError: false, error: null }),
}));

import StatementWorksheetPage from './[id]/page';
import { polyfillRadixSelect, renderWithProviders } from '../components/test-utils';

function line(id: string, amount: number, description: string, extra: Partial<ReconciliationLine> = {}): ReconciliationLine {
  return {
    id,
    journalEntryId: `je_${id}`,
    entryNumber: `JE-${id}`,
    date: '2026-01-10',
    description,
    amount,
    contactId: null,
    contactName: null,
    reference: null,
    sourceType: null,
    document: null,
    cleared: false,
    ...extra,
  };
}

function makeView(overrides: Partial<ReconciliationView> = {}): ReconciliationView {
  return {
    id: 'brec_1',
    bankAccountId: 'ba_1',
    bankAccountName: 'Operating',
    ledgerAccountId: 'acc_1',
    ledger: { code: '1000', name: 'Checking', type: 'asset' },
    accountKind: 'bank',
    status: 'in_progress',
    statementDate: '2026-01-31',
    beginningBalance: '500.00',
    statementEndingBalance: '1350.05',
    clearedBalance: '500.00',
    difference: '850.05',
    clearedLineIds: [],
    inflows: [line('d1', 1000, 'Deposit one'), line('d2', 250.1, 'Deposit two')],
    outflows: [line('c1', 300.05, 'Check 1042', { document: { type: 'payment', id: 'p', number: null, checkNumber: '1042', method: 'check' } }), line('c2', 100, 'Check 1043')],
    totals: {
      inflows: { count: 2, total: 1250.1, clearedCount: 0, clearedTotal: 0 },
      outflows: { count: 2, total: 400.05, clearedCount: 0, clearedTotal: 0 },
    },
    nettedLineCount: 0,
    adjustmentJournalEntryId: null,
    completedAt: null,
    completedBy: null,
    undoneAt: null,
    undoneBy: null,
    ...overrides,
  };
}

const finish = () => screen.getByTestId('finish-reconciliation');
const difference = () => screen.getByTestId('summary-difference');

describe('Statement reconciliation worksheet', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    view.current = makeView();
    completeMutate.mockReset();
    saveMutate.mockReset();
    navigate.mockReset();
    permissions.clear();
    permissions.add('banking:update');
  });

  it('keeps Finish disabled until the difference is zero', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StatementWorksheetPage />);

    // Nothing ticked: the statement is 850.05 above the beginning balance.
    expect(difference()).toHaveTextContent('$850.05');
    expect(finish()).toBeDisabled();
    expect(screen.getByText(/The difference must be 0\.00 to finish/)).toBeInTheDocument();

    await user.click(screen.getByTestId('line-d1'));
    await user.click(screen.getByTestId('line-d2'));
    expect(screen.getByTestId('summary-cleared')).toHaveTextContent('$1750.10');
    // The test formatter prints a negative amount as "$-400.05".
    expect(difference()).toHaveTextContent('$-400.05');
    expect(finish()).toBeDisabled();

    await user.click(screen.getByTestId('line-c1'));
    expect(finish()).toBeDisabled();
    await user.click(screen.getByTestId('line-c2'));
    expect(difference()).toHaveTextContent('$0.00');
    expect(finish()).toBeEnabled();
    expect(screen.queryByTestId('post-adjustment')).not.toBeInTheDocument();

    // Untick one check: off by that check again.
    await user.click(screen.getByTestId('line-c2'));
    expect(finish()).toBeDisabled();
    expect(screen.getByTestId('post-adjustment')).toBeInTheDocument();
  });

  it('finishes with the ticked lines', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StatementWorksheetPage />);
    for (const id of ['d1', 'd2', 'c1', 'c2']) await user.click(screen.getByTestId(`line-${id}`));
    await user.click(finish());

    expect(completeMutate).toHaveBeenCalledTimes(1);
    expect(completeMutate.mock.calls[0][0]).toEqual({ id: 'brec_1', data: { clearedLineIds: ['d1', 'd2', 'c1', 'c2'] } });
  });

  it('selects every line of a list at once', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StatementWorksheetPage />);

    await user.click(screen.getByTestId('inflows-select-all'));
    expect(screen.getByTestId('inflows-summary')).toHaveTextContent('2 of 2 selected · $1250.10');
    expect(screen.getByTestId('outflows-summary')).toHaveTextContent('0 of 2 selected');

    await user.click(screen.getByTestId('inflows-select-all'));
    expect(screen.getByTestId('inflows-summary')).toHaveTextContent('0 of 2 selected');
  });

  it('filters the lines by search text', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StatementWorksheetPage />);

    await user.type(screen.getByTestId('worksheet-search'), '1042');
    const outflows = screen.getByTestId('outflows');
    expect(within(outflows).getByText('Check 1042')).toBeInTheDocument();
    expect(within(outflows).queryByText('Check 1043')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('inflows')).queryByText('Deposit one')).not.toBeInTheDocument();
  });

  it('saves the ticks as progress, enabled only when something changed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StatementWorksheetPage />);

    expect(screen.getByTestId('save-progress')).toBeDisabled();
    await user.click(screen.getByTestId('line-d1'));
    expect(screen.getByTestId('save-progress')).toBeEnabled();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByTestId('save-progress'));
    expect(saveMutate.mock.calls[0][0]).toEqual({ id: 'brec_1', data: { clearedLineIds: ['d1'] } });
  });

  it('posts the difference to a chosen account, after an explicit confirmation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StatementWorksheetPage />);
    for (const id of ['d1', 'd2', 'c1']) await user.click(screen.getByTestId(`line-${id}`));
    // 100.00 short: a check is missing from the statement side.
    await user.click(screen.getByTestId('post-adjustment'));

    expect(screen.getByTestId('adjustment-effect')).toHaveTextContent('lower than your books');
    expect(screen.getByTestId('confirm-adjustment')).toBeDisabled();
    await user.click(screen.getByTestId('adjustment-account'));
    await user.click(await screen.findByRole('option', { name: /6150 — Bank fees/ }));
    await user.click(screen.getByTestId('confirm-adjustment'));

    expect(completeMutate.mock.calls[0][0]).toEqual({
      id: 'brec_1',
      data: { clearedLineIds: ['d1', 'd2', 'c1'], adjustment: { accountId: 'acc_fees' } },
    });
  });

  it('uses credit card wording and flipped signs for a card', () => {
    view.current = makeView({
      accountKind: 'credit_card',
      ledger: { code: '2100', name: 'Visa', type: 'liability' },
      beginningBalance: '400.00',
      statementEndingBalance: '-299.95',
      inflows: [line('p1', 1000, 'Payment, thank you')],
      outflows: [line('ch1', 300.05, 'Purchase')],
    });
    renderWithProviders(<StatementWorksheetPage />);

    expect(screen.getByText('Payments and credits')).toBeInTheDocument();
    expect(screen.getByText('Purchases and charges')).toBeInTheDocument();
    expect(screen.getByText('Statement balance owed')).toBeInTheDocument();
    expect(screen.queryByText('Checks and payments')).not.toBeInTheDocument();
  });

  it('shows a finished reconciliation read-only, with a link to its report', () => {
    view.current = makeView({ status: 'completed', clearedLineIds: ['d1'] });
    renderWithProviders(<StatementWorksheetPage />);

    expect(screen.getByText('This reconciliation is no longer open for changes.')).toBeInTheDocument();
    expect(screen.queryByTestId('finish-reconciliation')).not.toBeInTheDocument();
    expect(screen.getByTestId('line-d1')).toBeDisabled();
  });

  it('does not let a user without banking:update change anything', async () => {
    permissions.clear();
    permissions.add('banking:read');
    const user = userEvent.setup();
    renderWithProviders(<StatementWorksheetPage />);

    expect(screen.getByTestId('line-d1')).toBeDisabled();
    await user.click(screen.getByTestId('line-d1'));
    expect(screen.getByTestId('summary-cleared')).toHaveTextContent('$500.00');
    expect(finish()).toBeDisabled();
  });
});
