import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
    formatMoney: (value: string) => value,
    today: () => '2026-10-08',
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const navigateAway = vi.hoisted(() => vi.fn());
vi.mock('./navigate-away', () => ({ navigateAway }));
const loadStripe = vi.hoisted(() => vi.fn());
vi.mock('@stripe/stripe-js/pure', () => ({ loadStripe }));

import { ConnectBankButton } from './connect-bank-button';
import { readPendingLink } from './launchers';
import { resetPlaidLoaderForTests } from './launchers/plaid';
import {
  installPointerPolyfills,
  makeAccount,
  makeBankAccount,
  makeConnection,
  makeProvider,
  renderWithProviders,
} from './test-support';

const CALLBACK = `${window.location.origin}/weldbooks/banking/feeds/callback`;

function respond(providers: unknown, extra: Record<string, unknown> = {}) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/bank-connections/providers')) return { data: providers };
    if (path.startsWith('/bank-connections/institutions')) return { data: extra.institutions ?? [] };
    if (path.startsWith('/bank-accounts')) return { data: [makeBankAccount()] };
    return { data: [] };
  });
}

function installPlaid() {
  const handler = { open: vi.fn(), exit: vi.fn(), destroy: vi.fn() };
  const create = vi.fn(() => handler);
  (window as unknown as { Plaid: unknown }).Plaid = { create };
  type Options = { token: string; onSuccess: (token: string, metadata: unknown) => void; onExit: (e: unknown, m: unknown) => void };
  return { handler, options: () => (create.mock.calls[0] as unknown as [Options])[0] };
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  navigateAway.mockReset();
  loadStripe.mockReset();
  permissions.allowed = new Set(['banking:read', 'banking:create', 'banking:update', 'banking:manage']);
  window.sessionStorage.clear();
  resetPlaidLoaderForTests();
});

afterEach(() => {
  delete (window as unknown as { Plaid?: unknown }).Plaid;
  vi.unstubAllEnvs();
});

describe('ConnectBankButton', () => {
  it('starts Plaid Link at once when it is the only provider, and ends in the account mapping', async () => {
    const user = userEvent.setup();
    respond({ country: 'US', providers: [makeProvider('plaid', 'plaid_link')] });
    const linked = makeConnection({ accounts: [makeAccount({ feedAccountId: 'fa_9', name: 'Everyday' })] });
    api.post.mockImplementation(async (path: string) => {
      if (path === '/bank-connections/link-session') {
        return { data: { provider: 'plaid', kind: 'plaid_link', token: 'link-sandbox-1', historyDays: 730 } };
      }
      return { data: { connection: linked, accounts: linked.accounts } };
    });
    const plaid = installPlaid();

    renderWithProviders(<ConnectBankButton />);
    const button = await screen.findByRole('button', { name: 'Connect bank' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => expect(plaid.handler.open).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/bank-connections/link-session', {
      provider: 'plaid',
      mode: 'create',
      redirectUrl: CALLBACK,
    });
    expect(plaid.options().token).toBe('link-sandbox-1');

    plaid.options().onSuccess('public-1', { institution: { institution_id: 'ins_1', name: 'First Platypus Bank' } });

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/bank-connections/complete', {
        provider: 'plaid',
        payload: { publicToken: 'public-1', institution: { institutionId: 'ins_1', name: 'First Platypus Bank' } },
      }),
    );
    expect(await screen.findByRole('dialog', { name: 'Link your First Platypus Bank accounts' })).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('First Platypus Bank connected.');
  });

  it('opens Stripe Financial Connections for a stripe_fc session and completes with the session id', async () => {
    const user = userEvent.setup();
    vi.stubEnv('VITE_STRIPE_FC_PUBLISHABLE_KEY', 'pk_test_fc');
    respond({ country: 'US', providers: [makeProvider('stripe_fc', 'stripe_fc')] });
    const collect = vi.fn().mockResolvedValue({ financialConnectionsSession: { id: 'fcsess_9', accounts: [{ id: 'fca_1' }] } });
    loadStripe.mockResolvedValue({ collectFinancialConnectionsAccounts: collect });
    const linked = makeConnection({ provider: 'stripe_fc', accounts: [makeAccount({ bankAccountId: 'ba_1' })] });
    api.post.mockImplementation(async (path: string) => {
      if (path === '/bank-connections/link-session') {
        return { data: { provider: 'stripe_fc', kind: 'stripe_fc', clientSecret: 'fcsess_secret', sessionId: 'fcsess_9', historyDays: 180 } };
      }
      return { data: { connection: linked, accounts: linked.accounts } };
    });

    renderWithProviders(<ConnectBankButton />);
    const button = await screen.findByRole('button', { name: 'Connect bank' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => expect(collect).toHaveBeenCalledWith({ clientSecret: 'fcsess_secret' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/bank-connections/complete', {
        provider: 'stripe_fc',
        payload: { sessionId: 'fcsess_9' },
      }),
    );
  });

  it('lets the user choose among the providers that are configured, and redirects for Ponto', async () => {
    const user = userEvent.setup();
    respond({
      country: 'NL',
      providers: [makeProvider('plaid', 'plaid_link'), makeProvider('ponto', 'redirect')],
    });
    api.post.mockResolvedValue({
      data: { provider: 'ponto', kind: 'redirect', url: 'https://auth.ponto.example/authorize?state=s-1', historyDays: 90 },
    });

    renderWithProviders(<ConnectBankButton returnTo="/weldbooks/banking/ba_1" />);
    const button = await screen.findByRole('button', { name: 'Connect bank' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    const dialog = await screen.findByRole('dialog', { name: 'Connect your bank' });
    expect(within(dialog).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['plaid', 'ponto']);
    await user.click(within(dialog).getByRole('radio', { name: /Ponto/ }));
    expect(within(dialog).getByText(/sent to your bank to sign in/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(navigateAway).toHaveBeenCalledWith('https://auth.ponto.example/authorize?state=s-1'));
    expect(api.post).toHaveBeenCalledWith('/bank-connections/link-session', {
      provider: 'ponto',
      mode: 'create',
      redirectUrl: CALLBACK,
    });
    expect(readPendingLink()).toMatchObject({
      provider: 'ponto',
      kind: 'redirect',
      state: 's-1',
      returnTo: '/weldbooks/banking/ba_1',
    });
  });

  it('asks for the bank first when the provider needs it (Enable Banking)', async () => {
    const user = userEvent.setup();
    respond(
      { country: 'NL', providers: [makeProvider('enable_banking', 'redirect', { requiresInstitution: true })] },
      {
        institutions: [
          { id: 'ING', name: 'ING', country: 'NL' },
          { id: 'Rabobank', name: 'Rabobank', country: 'NL' },
        ],
      },
    );
    api.post.mockResolvedValue({
      data: { provider: 'enable_banking', kind: 'redirect', url: 'https://eb.example/auth', historyDays: 90 },
    });

    renderWithProviders(<ConnectBankButton />);
    const button = await screen.findByRole('button', { name: 'Connect bank' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    const dialog = await screen.findByRole('dialog', { name: 'Connect your bank' });
    const continueButton = within(dialog).getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();
    expect(api.get).toHaveBeenCalledWith('/bank-connections/institutions?provider=enable_banking&country=NL');

    await user.type(within(dialog).getByLabelText('Your bank'), 'rabo');
    expect(within(dialog).queryByRole('radio', { name: 'ING' })).not.toBeInTheDocument();
    await user.click(await within(dialog).findByRole('radio', { name: 'Rabobank' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Personal accounts' }));
    await user.click(continueButton);

    await waitFor(() => expect(navigateAway).toHaveBeenCalledWith('https://eb.example/auth'));
    expect(api.post).toHaveBeenCalledWith('/bank-connections/link-session', {
      provider: 'enable_banking',
      mode: 'create',
      redirectUrl: CALLBACK,
      institution: { id: 'Rabobank', name: 'Rabobank', country: 'NL' },
      psuType: 'personal',
    });
  });

  it('signs a connection in again: link-session in reauth mode, then complete without a public token', async () => {
    const user = userEvent.setup();
    respond({ country: 'US', providers: [makeProvider('plaid', 'plaid_link')] });
    const connection = makeConnection({
      status: 'reauth_required',
      accounts: [makeAccount({ bankAccountId: 'ba_1', bankAccountName: 'Operating' })],
    });
    api.post.mockImplementation(async (path: string) => {
      if (path === '/bank-connections/link-session') {
        return { data: { provider: 'plaid', kind: 'plaid_link', token: 'link-update-1', historyDays: 730 } };
      }
      return { data: { connection: { ...connection, status: 'active' }, accounts: connection.accounts } };
    });
    const plaid = installPlaid();

    renderWithProviders(<ConnectBankButton mode="reauth" connection={connection} label="Reconnect" />);
    const button = await screen.findByRole('button', { name: 'Reconnect' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => expect(plaid.handler.open).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/bank-connections/link-session', {
      provider: 'plaid',
      mode: 'reauth',
      connectionId: 'bkc_1',
      redirectUrl: CALLBACK,
    });
    plaid.options().onSuccess('public-ignored', {});

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/bank-connections/complete', {
        provider: 'plaid',
        payload: {},
        connectionId: 'bkc_1',
      }),
    );
    // The sync that was refused while the bank needed a sign-in runs right away.
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bank-connections/bkc_1/sync', { refresh: false }));
    expect(toast.success).toHaveBeenCalledWith('First Platypus Bank reconnected.');
  });

  it('shows nothing the user may not use, and a disabled button when no provider is configured', async () => {
    respond({ country: 'US', providers: [] });
    permissions.allowed = new Set(['banking:read']);
    const first = renderWithProviders(<ConnectBankButton />);
    expect(screen.queryByRole('button', { name: 'Connect bank' })).not.toBeInTheDocument();
    first.unmount();

    permissions.allowed = new Set(['banking:read', 'banking:create']);
    renderWithProviders(<ConnectBankButton />);
    const button = await screen.findByRole('button', { name: 'Connect bank' });
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(button).toBeDisabled();
  });

  it('reports a link that could not start, with what the provider said', async () => {
    const user = userEvent.setup();
    respond({ country: 'US', providers: [makeProvider('plaid', 'plaid_link')] });
    api.post.mockRejectedValue(Object.assign(new Error('Plaid INVALID_CONFIGURATION'), { status: 502, code: 'UPSTREAM_ERROR' }));

    renderWithProviders(<ConnectBankButton />);
    const button = await screen.findByRole('button', { name: 'Connect bank' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith(
      'The bank data provider could not complete the request. Try again in a few minutes. Reported: Plaid INVALID_CONFIGURATION',
    );
    expect(await screen.findByRole('button', { name: 'Connect bank' })).toBeEnabled();
  });

  it('says when a provider is not set up (503)', async () => {
    const user = userEvent.setup();
    respond({ country: 'US', providers: [makeProvider('plaid', 'plaid_link')] });
    api.post.mockRejectedValue(Object.assign(new Error('Plaid is not configured'), { status: 503, code: 'SERVICE_UNAVAILABLE' }));

    renderWithProviders(<ConnectBankButton />);
    const button = await screen.findByRole('button', { name: 'Connect bank' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('not set up yet')));
  });
});
