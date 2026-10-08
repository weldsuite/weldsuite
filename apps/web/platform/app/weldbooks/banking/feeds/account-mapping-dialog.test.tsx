import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string) => `on ${value}`,
    formatDateTime: (value: string) => value,
    formatMoney: (value: string, currency?: string) => `${currency ?? ''} ${value}`,
    today: () => '2026-10-08',
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { AccountMappingDialog } from './account-mapping-dialog';
import {
  STRIPE_CAPABILITIES,
  installPointerPolyfills,
  makeAccount,
  makeBankAccount,
  makeConnection,
  renderWithProviders,
} from './test-support';

const bankAccounts = [
  makeBankAccount({ id: 'ba_op', name: 'Operating', lastImportDate: '2026-09-01T10:30:00.000Z' }),
  makeBankAccount({ id: 'ba_sv', name: 'Savings' }),
  makeBankAccount({ id: 'ba_eur', name: 'Euro account', currency: 'EUR' }),
  makeBankAccount({ id: 'ba_taken', name: 'Taken elsewhere', feedConnectionId: 'bkc_other', feedStatus: 'active' }),
];

const connection = makeConnection({
  accounts: [
    makeAccount({
      feedAccountId: 'fa_checking',
      name: 'Business Checking',
      suggestion: { bankAccountId: 'ba_op', bankAccountName: 'Operating', reason: 'last4' },
    }),
    makeAccount({ feedAccountId: 'fa_card', name: 'Platinum Card', type: 'credit', subtype: 'credit_card', mask: '4242' }),
    makeAccount({ feedAccountId: 'fa_sav', name: 'Rainy Day', subtype: 'savings', mask: '9999' }),
    makeAccount({ feedAccountId: 'fa_done', name: 'Already linked', bankAccountId: 'ba_sv', bankAccountName: 'Savings' }),
  ],
});

function mapResult(syncStarted = true) {
  return {
    data: {
      connection,
      mapped: [
        { feedAccountId: 'fa_checking', bankAccountId: 'ba_op', created: false },
        { feedAccountId: 'fa_card', bankAccountId: 'ba_new', created: true },
      ],
      syncStarted,
    },
  };
}

function renderDialog(props: Partial<React.ComponentProps<typeof AccountMappingDialog>> = {}) {
  const onOpenChange = vi.fn();
  const onMapped = vi.fn();
  renderWithProviders(
    <AccountMappingDialog open onOpenChange={onOpenChange} onMapped={onMapped} connection={connection} {...props} />,
  );
  return { onOpenChange, onMapped };
}

const group = (name: string) => screen.getByRole('group', { name });

async function choose(user: ReturnType<typeof userEvent.setup>, scope: HTMLElement, control: string, option: string) {
  await user.click(within(scope).getByRole('combobox', { name: control }));
  await user.click(await screen.findByRole('option', { name: option }));
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ data: bankAccounts });
  api.post.mockReset().mockResolvedValue(mapResult());
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('AccountMappingDialog', () => {
  it('pre-selects the suggested bank account and starts its feed after the last import', async () => {
    renderDialog();

    const checking = await waitFor(() => group('Business Checking'));
    expect(within(checking).getByRole('combobox', { name: 'What to do' })).toHaveTextContent('Link to an existing bank account');
    expect(within(checking).getByRole('combobox', { name: 'WeldBooks bank account' })).toHaveTextContent('Operating');
    expect(within(checking).getByText('Matching last four digits')).toBeInTheDocument();
    expect(within(checking).getByLabelText('Import transactions from')).toHaveValue('2026-09-01');

    // Accounts without a match default to a new bank account, named after the bank.
    const card = group('Platinum Card');
    expect(within(card).getByLabelText('Name of the new bank account')).toHaveValue('First Platypus Bank Platinum Card');
    expect(within(card).getByRole('combobox', { name: 'Account type' })).toHaveTextContent('Credit card');
  });

  it('only shows accounts that are not linked yet', async () => {
    renderDialog();
    await waitFor(() => group('Business Checking'));
    expect(screen.queryByRole('group', { name: 'Already linked' })).not.toBeInTheDocument();
  });

  it('explains how far back the provider reaches: 730 days for Plaid, 180 for Stripe', async () => {
    const plaid = renderWithProviders(<AccountMappingDialog open onOpenChange={vi.fn()} connection={connection} />);
    expect(await screen.findByText(/Plaid provides up to 730 days/)).toBeInTheDocument();
    plaid.unmount();

    renderWithProviders(
      <AccountMappingDialog
        open
        onOpenChange={vi.fn()}
        connection={{ ...connection, provider: 'stripe_fc', capabilities: STRIPE_CAPABILITIES, historyDays: 180 }}
      />,
    );
    expect(await screen.findByText(/Stripe provides up to 180 days/)).toBeInTheDocument();
  });

  it('builds the mappings payload from link, create and skip, with start dates', async () => {
    const user = userEvent.setup();
    const { onMapped, onOpenChange } = renderDialog();
    const checking = await waitFor(() => group('Business Checking'));

    // Link: keep the suggested bank account, move the start date.
    fireEvent.change(within(checking).getByLabelText('Import transactions from'), { target: { value: '2026-09-15' } });

    // Create: rename, make it a savings account, start in the summer.
    const card = group('Platinum Card');
    fireEvent.change(within(card).getByLabelText('Name of the new bank account'), { target: { value: 'Amex Platinum' } });
    await choose(user, card, 'Account type', 'Savings');
    fireEvent.change(within(card).getByLabelText('Import transactions from'), { target: { value: '2026-06-01' } });

    // Skip.
    await choose(user, group('Rainy Day'), 'What to do', 'Do not import this account');
    expect(within(group('Rainy Day')).queryByLabelText('Import transactions from')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Link 2 accounts' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/bank-connections/bkc_1/map-accounts', {
      mappings: [
        { feedAccountId: 'fa_checking', bankAccountId: 'ba_op', syncFrom: '2026-09-15' },
        { feedAccountId: 'fa_card', create: { name: 'Amex Platinum', accountType: 'savings' }, syncFrom: '2026-06-01' },
      ],
      sync: true,
    });
    await waitFor(() => expect(onMapped).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith('2 accounts linked. First sync started. New transactions show up in a moment.');
  });

  it('sends null as the start date when it is cleared, and honours the sync checkbox', async () => {
    const user = userEvent.setup();
    renderDialog();
    const checking = await waitFor(() => group('Business Checking'));

    fireEvent.change(within(checking).getByLabelText('Import transactions from'), { target: { value: '' } });
    await choose(user, group('Platinum Card'), 'What to do', 'Do not import this account');
    await choose(user, group('Rainy Day'), 'What to do', 'Do not import this account');
    await user.click(screen.getByRole('checkbox', { name: 'Start the first sync right away' }));
    await user.click(screen.getByRole('button', { name: 'Link 1 account' }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/bank-connections/bkc_1/map-accounts', {
      mappings: [{ feedAccountId: 'fa_checking', bankAccountId: 'ba_op', syncFrom: null }],
      sync: false,
    });
  });

  it('does not offer bank accounts another connection feeds, and warns about a currency mismatch', async () => {
    const user = userEvent.setup();
    renderDialog();
    const checking = await waitFor(() => group('Business Checking'));

    await user.click(within(checking).getByRole('combobox', { name: 'WeldBooks bank account' }));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names).toEqual(['Operating (USD)', 'Savings (USD)', 'Euro account (EUR)']);

    await user.click(screen.getByRole('option', { name: 'Euro account (EUR)' }));
    expect(within(checking).getByText('This account is in USD, but the bank account is in EUR.')).toBeInTheDocument();
  });

  it('keeps the dialog open and shows what is wrong when a link is incomplete', async () => {
    const user = userEvent.setup();
    renderDialog();
    const card = await waitFor(() => group('Platinum Card'));

    await choose(user, card, 'What to do', 'Link to an existing bank account');
    await user.click(screen.getByRole('button', { name: 'Link 3 accounts' }));

    expect(await within(card).findByText('Select a bank account.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows a conflict from books-api in the dialog', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(Object.assign(new Error("Bank account 'Operating' is already linked"), { status: 409, code: 'CONFLICT' }));
    const { onMapped } = renderDialog();
    await waitFor(() => group('Business Checking'));

    await user.click(screen.getByRole('button', { name: 'Link 3 accounts' }));

    expect(await screen.findByText(/already linked to another bank connection/)).toBeInTheDocument();
    expect(onMapped).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Link 3 accounts' })).toBeEnabled();
  });

  it('offers the bank account the user came from to the first account without a match', async () => {
    renderDialog({ defaultBankAccountId: 'ba_sv' });
    const card = await waitFor(() => group('Platinum Card'));
    expect(within(card).getByRole('combobox', { name: 'WeldBooks bank account' })).toHaveTextContent('Savings');
  });
});
