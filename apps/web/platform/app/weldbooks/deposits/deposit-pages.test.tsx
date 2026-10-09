import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BankDepositDetail, UndepositedPayment } from '@/lib/api/domains/weldbooks-banking';

const voidMutateAsync = vi.fn();
const memoMutate = vi.fn();
const permissions = new Set(['banking:create', 'banking:update']);
const jurisdiction = { code: 'US' as string | null };
const undeposited: { rows: UndepositedPayment[] | undefined } = { rows: [] };
const deposit: { current: BankDepositDetail } = { current: undefined as unknown as BankDepositDetail };

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useParams: () => ({ id: 'dep_1' }),
  useNavigate: () => vi.fn(),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ code: jurisdiction.code }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    entityCurrency: 'USD',
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useUndepositedPayments: (options: { enabled?: boolean } = {}) => ({ data: options.enabled === false ? undefined : undeposited.rows }),
  useBankDeposit: () => ({ data: deposit.current, isLoading: false, isError: false }),
  useUpdateBankDepositMemo: () => ({ mutate: memoMutate, isPending: false, isError: false, error: null }),
  useVoidBankDeposit: () => ({ mutateAsync: voidMutateAsync, isError: false, error: null }),
}));

import DepositDetailPage from './[id]/page';
import { UndepositedFundsCallout } from '../banking/components/undeposited-funds-callout';
import { renderWithProviders } from '../banking/components/test-utils';

const payment = (id: string, amount: number): UndepositedPayment => ({
  paymentId: id,
  date: '2026-01-05',
  paymentMethod: 'check',
  checkNumber: null,
  reference: null,
  currency: 'USD',
  paymentAmount: amount.toFixed(2),
  amount,
  contactId: 'c1',
  contactName: 'Acme',
  journalEntryId: 'je1',
});

function makeDeposit(overrides: Partial<BankDepositDetail> = {}): BankDepositDetail {
  return {
    id: 'dep_1',
    bankAccountId: 'ba_1',
    date: '2026-01-06',
    amount: '1550.50',
    currency: 'USD',
    memo: 'January checks',
    status: 'posted',
    journalEntryId: 'je_1',
    bankTransactionId: null,
    createdBy: null,
    createdAt: '2026-01-06T10:00:00Z',
    bankAccountName: 'Operating',
    journalEntryNumber: 'JE-0007',
    payments: [
      { id: 'pay_1', date: '2026-01-05', amount: '1200.00', currency: 'USD', paymentMethod: 'check', checkNumber: '1001', reference: null, contactId: 'c1', contactName: 'Acme', invoiceId: 'inv_1' },
      { id: 'pay_2', date: '2026-01-06', amount: '350.50', currency: 'USD', paymentMethod: 'cash', checkNumber: null, reference: null, contactId: 'c2', contactName: 'Bolt', invoiceId: null },
    ],
    otherLines: [],
    ...overrides,
  };
}

describe('UndepositedFundsCallout', () => {
  beforeEach(() => {
    permissions.clear();
    permissions.add('banking:create');
    jurisdiction.code = 'US';
  });

  it('shows how many payments wait in Undeposited Funds and their total, with a link to deposit them', () => {
    undeposited.rows = [payment('a', 1200), payment('b', 350.5)];
    renderWithProviders(<UndepositedFundsCallout />);

    expect(screen.getByTestId('undeposited-funds-callout')).toHaveTextContent('2 payments ($1550.50) are waiting in Undeposited Funds.');
    expect(screen.getByRole('link', { name: 'Make a deposit' })).toHaveAttribute('href', '/weldbooks/deposits/new');
  });

  it('uses the singular for one payment', () => {
    undeposited.rows = [payment('a', 20)];
    renderWithProviders(<UndepositedFundsCallout />);
    expect(screen.getByTestId('undeposited-funds-callout')).toHaveTextContent('1 payment ($20.00) is waiting in Undeposited Funds.');
  });

  it('renders nothing when there is nothing to deposit, or for an entity without Undeposited Funds', () => {
    undeposited.rows = [];
    const { unmount } = renderWithProviders(<UndepositedFundsCallout />);
    expect(screen.queryByTestId('undeposited-funds-callout')).not.toBeInTheDocument();
    unmount();

    undeposited.rows = [payment('a', 20)];
    jurisdiction.code = 'NL';
    renderWithProviders(<UndepositedFundsCallout />);
    expect(screen.queryByTestId('undeposited-funds-callout')).not.toBeInTheDocument();
  });

  it('leaves out the deposit button for someone who cannot create deposits', () => {
    permissions.clear();
    undeposited.rows = [payment('a', 20)];
    renderWithProviders(<UndepositedFundsCallout />);
    expect(screen.queryByRole('link', { name: 'Make a deposit' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View deposits' })).toBeInTheDocument();
  });
});

describe('DepositDetailPage', () => {
  beforeEach(() => {
    voidMutateAsync.mockReset();
    voidMutateAsync.mockResolvedValue(undefined);
    memoMutate.mockReset();
    permissions.clear();
    permissions.add('banking:update');
    deposit.current = makeDeposit();
  });

  it('shows the deposit with its payments and the journal entry it posted', () => {
    renderWithProviders(<DepositDetailPage />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('$1550.50');
    expect(screen.getByRole('link', { name: 'JE-0007' })).toHaveAttribute('href', '/weldbooks/journal/$id');
    const table = screen.getByRole('table');
    expect(within(table).getByText('Acme')).toBeInTheDocument();
    expect(within(table).getByText('1001')).toBeInTheDocument();
    expect(screen.getByText('Not matched yet')).toBeInTheDocument();
  });

  it('voids the deposit after a confirmation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DepositDetailPage />);

    await user.click(screen.getByTestId('void-deposit'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('its payments go back to Undeposited Funds');
    expect(voidMutateAsync).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Void deposit' }));
    expect(voidMutateAsync).toHaveBeenCalledWith('dep_1');
  });

  it('saves a changed memo', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DepositDetailPage />);

    const save = screen.getByRole('button', { name: 'Save memo' });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText('Memo'), ' (late)');
    await user.click(save);
    expect(memoMutate).toHaveBeenCalledWith({ id: 'dep_1', memo: 'January checks (late)' });
  });

  it('cannot be voided or edited once void, or without banking:update', () => {
    deposit.current = makeDeposit({ status: 'void' });
    const { unmount } = renderWithProviders(<DepositDetailPage />);
    expect(screen.queryByTestId('void-deposit')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Memo')).toBeDisabled();
    unmount();

    deposit.current = makeDeposit();
    permissions.clear();
    renderWithProviders(<DepositDetailPage />);
    expect(screen.queryByTestId('void-deposit')).not.toBeInTheDocument();
  });
});
