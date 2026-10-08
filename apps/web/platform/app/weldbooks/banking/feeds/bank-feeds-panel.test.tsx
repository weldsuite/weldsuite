import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string) => value,
    formatDateTime: (value: string) => value,
    formatMoney: (value: string, currency?: string) => `${currency} ${value}`,
    today: () => '2026-10-08',
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { BankFeedsPanel, findAccountFeed } from './bank-feeds-panel';
import {
  installPointerPolyfills,
  makeAccount,
  makeBankAccount,
  makeConnection,
  makeProvider,
  renderWithProviders,
} from './test-support';

const linked = makeAccount({ feedAccountId: 'fa_1', bankAccountId: 'ba_1', bankAccountName: 'Operating' });

function routes(options: { connections?: unknown; providers?: unknown; pending?: unknown } = {}) {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/bank-connections') {
      if (options.connections instanceof Error) throw options.connections;
      return { data: options.connections ?? [] };
    }
    if (path.startsWith('/bank-connections/providers')) {
      return { data: options.providers ?? { country: 'US', providers: [makeProvider('plaid', 'plaid_link')] } };
    }
    if (path.startsWith('/bank-connections/bkc_1/pending')) return { data: options.pending ?? [] };
    if (path.startsWith('/bank-accounts')) return { data: [makeBankAccount()] };
    return { data: [] };
  });
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  permissions.allowed = new Set(['banking:read', 'banking:create', 'banking:update', 'banking:manage']);
});

describe('BankFeedsPanel overview', () => {
  it('shows a loading state, then the connections', async () => {
    routes({ connections: [makeConnection({ accounts: [linked] }), makeConnection({ id: 'bkc_2', institutionName: 'Second Bank', accounts: [linked] })] });
    renderWithProviders(<BankFeedsPanel />);

    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'First Platypus Bank' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Second Bank' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect another bank' })).toBeInTheDocument();
  });

  it('explains an empty workspace and offers Connect bank', async () => {
    routes({ connections: [] });
    renderWithProviders(<BankFeedsPanel />);

    expect(await screen.findByText('No bank connected yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect bank' })).toBeInTheDocument();
  });

  it('shows a load error with a retry', async () => {
    const user = userEvent.setup();
    routes({ connections: new Error('boom') });
    renderWithProviders(<BankFeedsPanel />);

    expect(await screen.findByText('Your bank connections could not be loaded.')).toBeInTheDocument();
    routes({ connections: [makeConnection({ accounts: [linked] })] });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'First Platypus Bank' })).toBeInTheDocument();
  });

  it('says so when no provider is available for the country, and disables Connect bank', async () => {
    routes({ connections: [], providers: { country: 'BE', providers: [] } });
    renderWithProviders(<BankFeedsPanel />);

    expect(await screen.findByText(/not available for BE yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect bank' })).toBeDisabled();
  });

  it('renders nothing for someone who may not read banking', () => {
    permissions.allowed = new Set();
    routes();
    const { container } = renderWithProviders(<BankFeedsPanel />);
    expect(container).toBeEmptyDOMElement();
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('BankFeedsPanel for one bank account', () => {
  it('shows the feed status of the account: bank, last synced, pending count and sync now', async () => {
    const user = userEvent.setup();
    routes({
      connections: [
        makeConnection({
          lastSyncedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
          accounts: [linked, makeAccount({ feedAccountId: 'fa_2', bankAccountId: 'ba_other' })],
        }),
      ],
      pending: [
        { id: 'p1', bankAccountId: 'ba_1', date: '2026-10-07', amount: '-10.00', currency: 'USD', description: 'Coffee', merchantName: null },
        { id: 'p2', bankAccountId: 'ba_1', date: '2026-10-07', amount: '-20.00', currency: 'USD', description: 'Lunch', merchantName: null },
      ],
    });
    api.post.mockResolvedValue({
      data: { outcome: { connectionId: 'bkc_1', status: 'active', added: 0, updated: 0, removed: 0, pending: 2, pendingVoided: 0, possibleDuplicates: 0, autoReconciled: 0, warnings: 0 }, connection: makeConnection() },
    });

    renderWithProviders(<BankFeedsPanel bankAccountId="ba_1" />);

    const panel = await screen.findByRole('region', { name: 'Bank feed' });
    expect(within(panel).getByText('Connected through First Platypus Bank')).toBeInTheDocument();
    expect(within(panel).getByText('Connected')).toBeInTheDocument();
    expect(within(panel).getByText(/Plaid · Last synced 3 minutes ago/)).toBeInTheDocument();
    expect(await within(panel).findByRole('button', { name: '2 pending transactions' })).toBeEnabled();
    expect(api.get).toHaveBeenCalledWith('/bank-connections/bkc_1/pending?bankAccountId=ba_1');

    await user.click(within(panel).getByRole('button', { name: '2 pending transactions' }));
    expect(await within(panel).findByText('Coffee')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Already up to date.'));
    expect(within(panel).getByRole('link', { name: 'Manage bank feed' })).toHaveAttribute('href', '/weldbooks/banking/feeds');
  });

  it('asks to reconnect when the bank needs a new sign-in', async () => {
    routes({ connections: [makeConnection({ status: 'reauth_required', accounts: [linked] })] });
    renderWithProviders(<BankFeedsPanel bankAccountId="ba_1" />);

    const panel = await screen.findByRole('region', { name: 'Bank feed' });
    expect(within(panel).getByText('Reconnect needed')).toBeInTheDocument();
    expect(within(panel).getByText(/needs you to sign in again/)).toBeInTheDocument();
    expect(await within(panel).findByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('invites to connect a feed when the account has none', async () => {
    routes({ connections: [makeConnection({ accounts: [linked] })] });
    renderWithProviders(<BankFeedsPanel bankAccountId="ba_without_feed" />);

    expect(await screen.findByText('No bank feed on this account')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect bank feed' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All bank feeds' })).toHaveAttribute('href', '/weldbooks/banking/feeds');
  });

  it('offers to connect again when the feed behind the account has ended', async () => {
    routes({ connections: [makeConnection({ status: 'revoked', accounts: [linked] })] });
    renderWithProviders(<BankFeedsPanel bankAccountId="ba_1" />);

    const panel = await screen.findByRole('region', { name: 'Bank feed' });
    expect(within(panel).getByText('Access revoked')).toBeInTheDocument();
    expect(await within(panel).findByRole('button', { name: 'Connect again' })).toBeInTheDocument();
  });

  it('shows a loading state and a load error', async () => {
    routes({ connections: new Error('boom') });
    renderWithProviders(<BankFeedsPanel bankAccountId="ba_1" />);
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(await screen.findByText('Your bank connections could not be loaded.')).toBeInTheDocument();
  });
});

describe('findAccountFeed', () => {
  it('prefers a live connection over one that ended for the same bank account', () => {
    const ended = makeConnection({ id: 'old', status: 'revoked', accounts: [linked] });
    const live = makeConnection({ id: 'new', accounts: [linked] });
    expect(findAccountFeed([ended, live], 'ba_1')?.connection.id).toBe('new');
    expect(findAccountFeed([ended], 'ba_1')?.connection.id).toBe('old');
    expect(findAccountFeed([ended, live], 'ba_none')).toBeNull();
  });
});
