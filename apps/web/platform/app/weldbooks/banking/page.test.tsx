import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
    entityCurrency: 'USD',
    formatDate: (value: string) => value,
    formatDateTime: (value: string) => value,
    formatMoney: (value: string, currency?: string) => `${currency} ${value}`,
    today: () => '2026-10-08',
  }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ code: 'US' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock('./components/undeposited-funds-callout', () => ({ UndepositedFundsCallout: () => null }));
vi.mock('./components/bank-account-form-dialog', () => ({
  BankAccountFormDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="New bank account form" /> : null,
}));

import BankAccountsPage from './page';
import {
  installPointerPolyfills,
  makeBankAccount,
  makeProvider,
  renderWithProviders,
} from './feeds/test-support';

const TWO_PROVIDERS = {
  country: 'US',
  providers: [makeProvider('plaid', 'plaid_link'), makeProvider('stripe_fc', 'stripe_fc')],
};

function routes(options: { accounts?: unknown[]; providers?: unknown } = {}) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/bank-accounts')) return { data: options.accounts ?? [] };
    if (path === '/bank-connections') return { data: [] };
    if (path.startsWith('/bank-connections/providers')) return { data: options.providers ?? TWO_PROVIDERS };
    return { data: [] };
  });
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  permissions.allowed = new Set(['banking:read', 'banking:create']);
});

describe('BankAccountsPage', () => {
  it('leads the empty list with Connect bank, keeps adding an account by hand, and hides the statement tools', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<BankAccountsPage />);

    expect(await screen.findByText('No bank accounts configured')).toBeInTheDocument();
    expect(
      screen.getByText('Connect your bank to bring in your accounts and transactions automatically, or add an account yourself.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Bank feeds' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Import statement/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Reconcile statement/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Make deposit/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Connect bank' }));
    expect(await screen.findByRole('dialog', { name: 'Connect your bank' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Add account manually' }));
    expect(screen.getByRole('dialog', { name: 'New bank account form' })).toBeInTheDocument();
  });

  it('falls back to adding the first account when no bank feed serves this country', async () => {
    routes({ providers: { country: 'US', providers: [] } });
    renderWithProviders(<BankAccountsPage />);

    expect(await screen.findByRole('button', { name: 'Add your first bank account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect bank' })).not.toBeInTheDocument();
  });

  it('falls back to adding the first account for someone who may not connect a bank', async () => {
    permissions.allowed = new Set(['banking:read']);
    routes();
    renderWithProviders(<BankAccountsPage />);

    expect(await screen.findByRole('button', { name: 'Add your first bank account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect bank' })).not.toBeInTheDocument();
  });

  it('lists the accounts with the statement tools, and a one-line bank feed prompt above them', async () => {
    routes({ accounts: [makeBankAccount({ accountType: 'checking', accountNumberLast4: '7890' })] });
    renderWithProviders(<BankAccountsPage />);

    expect(await screen.findByText('Operating')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Import statement/ })).toHaveAttribute('href', '/weldbooks/banking/import');
    expect(screen.getByRole('link', { name: /Reconcile statement/ })).toHaveAttribute('href', '/weldbooks/banking/statements');
    expect(screen.getByRole('link', { name: /Make deposit/ })).toHaveAttribute('href', '/weldbooks/deposits/new');

    const strip = await screen.findByRole('region', { name: 'Bank feeds' });
    expect(strip).toHaveTextContent('Connect your bank and new transactions arrive on their own.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect bank' })).toBeEnabled());
  });
});
