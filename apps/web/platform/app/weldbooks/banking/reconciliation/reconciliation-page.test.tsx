import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BankLine, MatchSuggestion, UsBankAccount } from '@/lib/api/domains/weldbooks-banking';

const matchPaymentMutate = vi.fn();
const matchDepositMutate = vi.fn();
const reconcileMutate = vi.fn();
/** What every `useMutation` of the page reports: the last refusal and the variables it was sent with. */
const mutationState = { error: null as Error | null, variables: undefined as unknown };
const permissions = new Set(['banking:update']);
const jurisdiction = { code: 'US' as string | null };

const lines = [
  { id: 'bt_1', bankAccountId: 'ba_1', date: '2026-01-07', description: 'CHECK 1042', amount: '-300.05', counterpartyName: null, status: 'unreconciled', checkNumber: '1042', source: 'feed' },
  { id: 'bt_2', bankAccountId: 'ba_1', date: '2026-01-08', description: 'DEPOSIT', amount: '1550.50', counterpartyName: null, status: 'unreconciled', checkNumber: null, source: 'import' },
  { id: 'bt_3', bankAccountId: 'ba_1', date: '2026-01-09', description: 'Huur kantoor januari', amount: '-1200.00', counterpartyName: 'Vastgoed BV', status: 'unreconciled', checkNumber: null, source: null },
] as BankLine[];

const suggestionsByLine: Record<string, MatchSuggestion[]> = {
  bt_1: [{ type: 'payment', id: 'pay_1', number: '1042', contactName: 'Bolt', amount: '300.05', confidence: 0.9, reasons: ['check number matches'] }],
  bt_2: [
    { type: 'deposit', id: 'dep_1', number: 'January checks', contactName: null, amount: '1550.50', confidence: 0.75, reasons: ['deposit total matches'] },
    { type: 'invoice', id: 'inv_1', number: 'INV-1', contactName: 'Acme', amount: '1550.50', confidence: 0.5, reasons: ['exact amount match'] },
  ],
  bt_3: [
    { type: 'rule', id: 'rr_rent', number: 'Rent rule', contactName: null, amount: '1200.00', confidence: 0.7, reasons: ['reconciliation rule matches'], categoryAccountId: 'acc_rent' },
  ],
};
const bankAccounts = [{ id: 'ba_1', name: 'Operating', iban: null, accountNumberLast4: '7890', currency: 'USD' }] as UsBankAccount[];
const search: { accountId?: string; lineId?: string } = {};
/** What the paged list of unreconciled lines reports, and the filters it was asked for. */
const paging = {
  totalCount: null as number | null,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  filters: [] as Array<Record<string, unknown>>,
};
/** A line the page was asked to read by id (not on a loaded page). */
const fetchedLine: { line: BankLine | undefined } = { line: undefined };

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
  useSearch: () => search,
}));
vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ code: jurisdiction.code }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    currency: 'USD',
  }),
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: {} }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({ useAccountingAccounts: () => ({ data: { data: [] } }) }));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useMutation: () => ({
    mutate: reconcileMutate,
    isPending: false,
    isSuccess: false,
    error: mutationState.error,
    variables: mutationState.variables,
    data: undefined,
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankAccounts: () => ({ data: { data: bankAccounts } }),
  useInfiniteBankLines: (filters?: { bankAccountId?: string }) => {
    if (filters) paging.filters.push(filters);
    const rows = filters ? lines.filter((l) => l.bankAccountId === filters.bankAccountId) : [];
    return {
      data: filters ? { lines: rows, totalCount: paging.totalCount ?? rows.length } : undefined,
      isLoading: false,
      hasNextPage: paging.hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage: paging.fetchNextPage,
    };
  },
  useBankLine: (id: string | undefined) => ({ data: id ? fetchedLine.line : undefined }),
  useBankLineSuggestions: (id: string | null) => ({ data: id ? suggestionsByLine[id] : [] }),
  useMatchBankLineToPayment: () => ({ mutate: matchPaymentMutate, isPending: false, error: null }),
  useMatchBankLineToDeposit: () => ({ mutate: matchDepositMutate, isPending: false, error: null }),
}));

import BankReconciliationPage from './page';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { polyfillRadixSelect, renderWithProviders } from '../components/test-utils';

async function chooseAccount() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name: /Operating/ }));
  return user;
}

describe('Bank reconciliation page', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    matchPaymentMutate.mockReset();
    matchDepositMutate.mockReset();
    reconcileMutate.mockReset();
    mutationState.error = null;
    mutationState.variables = undefined;
    permissions.clear();
    permissions.add('banking:update');
    jurisdiction.code = 'US';
    bankAccounts.splice(1);
    delete search.accountId;
    delete search.lineId;
    paging.totalCount = null;
    paging.hasNextPage = false;
    paging.fetchNextPage.mockReset();
    paging.filters.length = 0;
    fetchedLine.line = undefined;
    panelOpen.mockReset();
  });

  it('opens on the only bank account without choosing it', () => {
    renderWithProviders(<BankReconciliationPage />);
    expect(screen.getByText('CHECK 1042')).toBeInTheDocument();
  });

  it('opens on the account named in the URL when there are several', () => {
    bankAccounts.push({ id: 'ba_2', name: 'Savings', iban: 'NL00TEST', accountNumberLast4: null, currency: 'EUR' } as UsBankAccount);
    const { unmount } = renderWithProviders(<BankReconciliationPage />);
    expect(screen.queryByText('CHECK 1042')).not.toBeInTheDocument();
    unmount();

    search.accountId = 'ba_1';
    renderWithProviders(<BankReconciliationPage />);
    expect(screen.getByText('CHECK 1042')).toBeInTheDocument();
  });

  it('titles a line by its counterparty, else its description, and marks the selected one', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BankReconciliationPage />);
    const rent = screen.getByTestId('reconcile-line-bt_3');
    expect(within(rent).getByText('Vastgoed BV')).toBeInTheDocument();
    expect(within(rent).getByText('Huur kantoor januari')).toBeInTheDocument();
    expect(within(screen.getByTestId('reconcile-line-bt_2')).getByText('DEPOSIT')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();

    await user.click(rent);
    expect(rent).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('reconcile-line-bt_2')).toHaveAttribute('aria-pressed', 'false');
  });

  it('categorizes a line with a matching reconciliation rule', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BankReconciliationPage />);
    await user.click(screen.getByTestId('reconcile-line-bt_3'));
    const suggestion = await screen.findByTestId('suggestion-rule');
    expect(within(suggestion).getByText('Rent rule')).toBeInTheDocument();
    expect(within(suggestion).getByText('Matches a reconciliation rule')).toBeInTheDocument();
    await user.click(screen.getByTestId('match-rule'));
    expect(reconcileMutate.mock.calls[0][0]).toEqual({ txnId: 'bt_3', data: { type: 'manual', ruleId: 'rr_rent' } });
  });

  it('words the categorize box for money out as a bank fee or a tax payment, not as a customer payment', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BankReconciliationPage />);

    // Money in (the deposit): the invoice wording.
    await user.click(screen.getByTestId('reconcile-line-bt_2'));
    expect(await screen.findByText('Not an invoice?')).toBeInTheDocument();
    expect(screen.queryByText('Not a bill?')).not.toBeInTheDocument();

    // Money out (the check): the bill wording.
    await user.click(screen.getByTestId('reconcile-line-bt_1'));
    expect(await screen.findByText('Not a bill?')).toBeInTheDocument();
    expect(screen.getByText(/bank fees, card charges, tax payments, owner withdrawals/)).toBeInTheDocument();
    expect(screen.getByText('Typical accounts: Bank fees, Taxes payable, Owner drawings.')).toBeInTheDocument();
    expect(screen.queryByText('Not an invoice?')).not.toBeInTheDocument();
  });

  it('shows a refused categorize once, in the categorize box', async () => {
    const user = userEvent.setup();
    mutationState.error = new Error('This bank account is not linked to a ledger account.');
    mutationState.variables = { txnId: 'bt_1', data: { type: 'manual', categoryAccountId: 'acc_fees' } };
    renderWithProviders(<BankReconciliationPage />);
    await user.click(screen.getByTestId('reconcile-line-bt_1'));

    expect(await screen.findByTestId('categorize-error')).toHaveTextContent('not linked to a ledger account');
    expect(screen.queryByTestId('match-error')).not.toBeInTheDocument();
    expect(screen.getAllByText(/not linked to a ledger account/)).toHaveLength(1);
  });

  it('shows a refused match once, under the suggestions', async () => {
    const user = userEvent.setup();
    mutationState.error = new Error('This bank account is not linked to a ledger account.');
    mutationState.variables = { txnId: 'bt_3', data: { type: 'manual', ruleId: 'rr_rent' } };
    renderWithProviders(<BankReconciliationPage />);
    await user.click(screen.getByTestId('reconcile-line-bt_3'));

    expect(await screen.findByTestId('match-error')).toHaveTextContent('not linked to a ledger account');
    expect(screen.queryByTestId('categorize-error')).not.toBeInTheDocument();
    expect(screen.getAllByText(/not linked to a ledger account/)).toHaveLength(1);
  });

  it('shows the check number and the source of each bank line', async () => {
    renderWithProviders(<BankReconciliationPage />);
    await chooseAccount();

    expect(screen.getByText('Check #1042')).toBeInTheDocument();
    expect(screen.getByText('Bank feed')).toBeInTheDocument();
    expect(screen.getByText('File import')).toBeInTheDocument();
  });

  it('matches a bank line to a payment that is already recorded', async () => {
    renderWithProviders(<BankReconciliationPage />);
    const user = await chooseAccount();

    await user.click(screen.getByText('CHECK 1042'));
    const suggestion = await screen.findByTestId('suggestion-payment');
    expect(within(suggestion).getByText('Check number matches')).toBeInTheDocument();
    await user.click(screen.getByTestId('match-payment'));

    expect(matchPaymentMutate.mock.calls[0][0]).toEqual({ lineId: 'bt_1', paymentId: 'pay_1' });
    expect(matchDepositMutate).not.toHaveBeenCalled();
    expect(reconcileMutate).not.toHaveBeenCalled();
  });

  it('matches a deposit line to the bank deposit, and an invoice through the existing reconcile flow', async () => {
    renderWithProviders(<BankReconciliationPage />);
    const user = await chooseAccount();

    await user.click(screen.getByText('DEPOSIT'));
    await user.click(await screen.findByTestId('match-deposit'));
    expect(matchDepositMutate.mock.calls[0][0]).toEqual({ lineId: 'bt_2', depositId: 'dep_1' });

    await user.click(screen.getByTestId('match-invoice'));
    expect(reconcileMutate.mock.calls[0][0]).toEqual({ txnId: 'bt_2', data: { type: 'invoice', entityId: 'inv_1' } });
  });

  it('offers the statement reconciliation to US entities only', async () => {
    const { unmount } = renderWithProviders(<BankReconciliationPage />);
    expect(screen.getByRole('link', { name: /Reconcile statement/ })).toHaveAttribute('href', '/weldbooks/banking/statements');
    unmount();

    jurisdiction.code = 'NL';
    renderWithProviders(<BankReconciliationPage />);
    expect(screen.queryByRole('link', { name: /Reconcile statement/ })).not.toBeInTheDocument();
  });

  it('counts every unreconciled line, not just the ones that have loaded', () => {
    paging.totalCount = 120;
    renderWithProviders(<BankReconciliationPage />);
    expect(screen.getByText('Unreconciled Transactions (120)')).toBeInTheDocument();
  });

  it('loads further pages on demand and says how many are shown', async () => {
    const user = userEvent.setup();
    paging.totalCount = 120;
    paging.hasNextPage = true;
    renderWithProviders(<BankReconciliationPage />);

    expect(screen.getByRole('status')).toHaveTextContent('3 of 120 shown');
    await user.click(screen.getByTestId('reconcile-load-more'));
    expect(paging.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('offers no Load more on the last page', () => {
    renderWithProviders(<BankReconciliationPage />);
    expect(screen.queryByTestId('reconcile-load-more')).not.toBeInTheDocument();
  });

  it('searches the unreconciled lines on the server, after a pause in typing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BankReconciliationPage />);
    await user.type(screen.getByRole('searchbox', { name: 'Search transactions' }), 'huur');

    await waitFor(() => expect(paging.filters.at(-1)).toMatchObject({ status: 'unreconciled', search: 'huur' }));
    // Every keystroke did not ask the server.
    expect(paging.filters.filter((f) => f.search === 'h' || f.search === 'hu')).toHaveLength(0);
  });

  it('selects the line named in the URL, even when it is not on a loaded page', async () => {
    search.accountId = 'ba_1';
    search.lineId = 'bt_far';
    fetchedLine.line = { ...lines[0], id: 'bt_far', description: 'Far away line' } as BankLine;
    renderWithProviders(<BankReconciliationPage />);
    expect(await screen.findByTestId('open-line-details')).toBeInTheDocument();
  });

  it('opens the selected line in its panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BankReconciliationPage />);
    await user.click(screen.getByTestId('reconcile-line-bt_3'));
    await user.click(await screen.findByTestId('open-line-details'));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'bank_transaction', id: 'bt_3' });
  });

  it('shows the suggested invoice as a chip that opens it, so it can be checked before matching', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BankReconciliationPage />);
    await user.click(screen.getByTestId('reconcile-line-bt_2'));
    const chip = await screen.findByRole('link', { name: /INV-1/ });
    await user.click(chip);
    expect(panelOpen).toHaveBeenCalledWith({ type: 'invoice', id: 'inv_1', stack: true });
    // Opening it does not match the line.
    expect(reconcileMutate).not.toHaveBeenCalled();
  });

  it('cannot match without banking:update', async () => {
    permissions.clear();
    renderWithProviders(<BankReconciliationPage />);
    const user = await chooseAccount();
    await user.click(screen.getByText('CHECK 1042'));
    expect(await screen.findByTestId('match-payment')).toBeDisabled();
  });
});
