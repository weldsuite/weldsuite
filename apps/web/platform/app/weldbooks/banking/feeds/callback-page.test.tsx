import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: () => true }) }));
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
const push = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ history: { push } }) }));

import BankFeedsCallbackPage from './callback-page';
import { readPendingLink, savePendingLink } from './launchers';
import {
  installPointerPolyfills,
  makeAccount,
  makeBankAccount,
  makeConnection,
  renderWithProviders,
} from './test-support';

const REDIRECT_URL = 'https://app.example/weldbooks/banking/feeds/callback';

function arriveAt(search: string) {
  window.history.pushState({}, '', `/weldbooks/banking/feeds/callback${search}`);
}

function completeResponse(connection = makeConnection()) {
  return { data: { connection, accounts: connection.accounts } };
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ data: [makeBankAccount()] });
  api.post.mockReset().mockResolvedValue(completeResponse());
  toast.success.mockReset();
  push.mockReset();
  window.sessionStorage.clear();
});

afterEach(() => {
  delete (window as unknown as { Plaid?: unknown }).Plaid;
  window.history.pushState({}, '', '/');
});

describe('BankFeedsCallbackPage', () => {
  it('completes a Ponto link with the code and state of the redirect and the stored provider', async () => {
    savePendingLink({
      provider: 'ponto',
      kind: 'redirect',
      mode: 'create',
      redirectUrl: REDIRECT_URL,
      returnTo: '/weldbooks/banking',
      state: 'state-1',
    });
    arriveAt('?code=auth-code&state=state-1');

    renderWithProviders(<BankFeedsCallbackPage />);

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/bank-connections/complete', {
      provider: 'ponto',
      payload: { code: 'auth-code', state: 'state-1', redirectUrl: REDIRECT_URL },
      connectionId: undefined,
    });
    // One link per return: a reload cannot replay the one-time code.
    expect(readPendingLink()).toBeNull();
  });

  it('completes an Enable Banking link with its code, and shows the account mapping', async () => {
    api.post.mockResolvedValue(
      completeResponse(makeConnection({ provider: 'enable_banking', institutionName: 'ING', accounts: [makeAccount()] })),
    );
    savePendingLink({
      provider: 'enable_banking',
      kind: 'redirect',
      mode: 'create',
      redirectUrl: REDIRECT_URL,
      returnTo: '/weldbooks/banking/ba_1',
      defaultBankAccountId: 'ba_1',
    });
    arriveAt('?code=eb-code&state=eb-state');

    renderWithProviders(<BankFeedsCallbackPage />);

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/bank-connections/complete', {
      provider: 'enable_banking',
      payload: { code: 'eb-code', state: 'eb-state', redirectUrl: REDIRECT_URL },
      connectionId: undefined,
    });
    expect(await screen.findByRole('dialog', { name: 'Link your ING accounts' })).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('returns to the page the link started from when nothing needs mapping (a reconnect)', async () => {
    api.post.mockResolvedValue(completeResponse(makeConnection({ accounts: [makeAccount({ bankAccountId: 'ba_1' })] })));
    savePendingLink({
      provider: 'ponto',
      kind: 'redirect',
      mode: 'reauth',
      connectionId: 'bkc_1',
      redirectUrl: REDIRECT_URL,
      returnTo: '/weldbooks/banking/feeds',
    });
    arriveAt('?code=again');

    renderWithProviders(<BankFeedsCallbackPage />);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/weldbooks/banking/feeds'));
    expect(api.post).toHaveBeenCalledWith('/bank-connections/complete', {
      provider: 'ponto',
      payload: { code: 'again', redirectUrl: REDIRECT_URL },
      connectionId: 'bkc_1',
    });
    expect(toast.success).toHaveBeenCalledWith('First Platypus Bank reconnected.');
  });

  it('refuses a return whose state is not the one that was sent', async () => {
    savePendingLink({
      provider: 'ponto',
      kind: 'redirect',
      mode: 'create',
      redirectUrl: REDIRECT_URL,
      returnTo: '/weldbooks/banking',
      state: 'expected',
    });
    arriveAt('?code=auth-code&state=forged');

    renderWithProviders(<BankFeedsCallbackPage />);

    expect(await screen.findByText(/does not match the connection you started/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('says so when the bank sent no code, or refused', async () => {
    savePendingLink({ provider: 'ponto', kind: 'redirect', mode: 'create', redirectUrl: REDIRECT_URL, returnTo: '/weldbooks/banking' });
    arriveAt('?state=x');
    const first = renderWithProviders(<BankFeedsCallbackPage />);
    expect(await screen.findByText('Your bank did not return an authorization code.')).toBeInTheDocument();
    first.unmount();

    savePendingLink({ provider: 'ponto', kind: 'redirect', mode: 'create', redirectUrl: REDIRECT_URL, returnTo: '/weldbooks/banking' });
    arriveAt('?error=access_denied&error_description=User%20cancelled');
    renderWithProviders(<BankFeedsCallbackPage />);
    expect(await screen.findByText('Your bank did not approve the connection: User cancelled')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('explains a visit without a started link', async () => {
    arriveAt('?code=orphan');
    renderWithProviders(<BankFeedsCallbackPage />);
    expect(await screen.findByText(/could not be found. Start again from Bank feeds/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Back to bank feeds' })).toBeInTheDocument();
  });

  it('shows what the server said when completing fails', async () => {
    api.post.mockRejectedValue(Object.assign(new Error('Ponto invalid_grant'), { status: 502, code: 'UPSTREAM_ERROR' }));
    savePendingLink({ provider: 'ponto', kind: 'redirect', mode: 'create', redirectUrl: REDIRECT_URL, returnTo: '/weldbooks/banking' });
    arriveAt('?code=auth-code');

    renderWithProviders(<BankFeedsCallbackPage />);

    expect(await screen.findByText(/could not complete the request/)).toBeInTheDocument();
    expect(screen.getByText('Reported: Ponto invalid_grant')).toBeInTheDocument();
  });

  it('re-opens Plaid Link after an OAuth bank returns, then completes with the public token', async () => {
    const handler = { open: vi.fn(), exit: vi.fn(), destroy: vi.fn() };
    const create = vi.fn(() => handler);
    (window as unknown as { Plaid: unknown }).Plaid = { create };
    savePendingLink({
      provider: 'plaid',
      kind: 'plaid_link',
      mode: 'create',
      redirectUrl: REDIRECT_URL,
      returnTo: '/weldbooks/banking',
      linkToken: 'link-oauth-token',
    });
    arriveAt('?oauth_state_id=oauth-1');

    renderWithProviders(<BankFeedsCallbackPage />);

    await waitFor(() => expect(handler.open).toHaveBeenCalled());
    const options = (create.mock.calls[0] as unknown as [
      { token: string; receivedRedirectUri: string; onSuccess: (token: string, metadata: unknown) => void },
    ])[0];
    expect(options.token).toBe('link-oauth-token');
    expect(options.receivedRedirectUri).toBe(window.location.href);
    expect(options.receivedRedirectUri).toContain('oauth_state_id=oauth-1');

    options.onSuccess('public-oauth', { institution: { institution_id: 'ins_9', name: 'Chase' } });

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/bank-connections/complete', {
      provider: 'plaid',
      payload: { publicToken: 'public-oauth', institution: { institutionId: 'ins_9', name: 'Chase' } },
      connectionId: undefined,
    });
  });
});
