import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankFeedLinkSession } from '@/lib/api/domains/weldbooks-bank-feeds';

const loadStripe = vi.hoisted(() => vi.fn());
vi.mock('@stripe/stripe-js/pure', () => ({ loadStripe }));

import { launcherFor } from './index';
import { launchPlaid, plaidPayload, resetPlaidLoaderForTests, resumePlaidOAuth } from './plaid';
import { readPendingLink, clearPendingLink, safeReturnPath, savePendingLink } from './pending-link';
import { launchRedirect } from './redirect';
import { launchStripeFc, stripeFcPublishableKey } from './stripe-fc';
import { BankFeedLaunchError, type LaunchContext } from './types';

const navigate = vi.fn();

function context(overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    provider: 'plaid',
    mode: 'create',
    redirectUrl: 'https://app.example/weldbooks/banking/feeds/callback',
    returnTo: '/weldbooks/banking',
    navigate,
    ...overrides,
  };
}

function session(overrides: Partial<BankFeedLinkSession> = {}): BankFeedLinkSession {
  return { provider: 'plaid', kind: 'plaid_link', historyDays: 730, ...overrides };
}

beforeEach(() => {
  navigate.mockReset();
  loadStripe.mockReset();
  window.sessionStorage.clear();
  resetPlaidLoaderForTests();
});

afterEach(() => {
  delete (window as unknown as { Plaid?: unknown }).Plaid;
  vi.unstubAllEnvs();
});

describe('launcherFor', () => {
  it('picks the launcher by the link session kind', () => {
    expect(launcherFor('plaid_link')).toBe(launchPlaid);
    expect(launcherFor('stripe_fc')).toBe(launchStripeFc);
    expect(launcherFor('redirect')).toBe(launchRedirect);
  });
});

describe('Plaid launcher', () => {
  function installPlaid() {
    const handler = { open: vi.fn(), exit: vi.fn(), destroy: vi.fn() };
    const create = vi.fn(() => handler);
    (window as unknown as { Plaid: unknown }).Plaid = { create };
    return { create, handler };
  }

  type CreateOptions = {
    token: string;
    receivedRedirectUri?: string;
    onSuccess: (publicToken: string, metadata: unknown) => void;
    onExit: (error: unknown, metadata: unknown) => void;
  };
  const optionsOf = (create: ReturnType<typeof vi.fn>): CreateOptions =>
    (create.mock.calls[0] as unknown as [CreateOptions])[0];

  it('opens Link with the link token and returns the public token and institution', async () => {
    const { create, handler } = installPlaid();
    const pending = launchPlaid(session({ token: 'link-sandbox-1' }), context());

    await vi.waitFor(() => expect(handler.open).toHaveBeenCalled());
    expect(optionsOf(create).token).toBe('link-sandbox-1');
    optionsOf(create).onSuccess('public-sandbox-1', { institution: { institution_id: 'ins_3', name: 'Chase' } });

    await expect(pending).resolves.toEqual({
      status: 'completed',
      payload: { publicToken: 'public-sandbox-1', institution: { institutionId: 'ins_3', name: 'Chase' } },
    });
    expect(handler.destroy).toHaveBeenCalled();
  });

  it('sends no public token in update mode: the stored access token is reused', () => {
    expect(plaidPayload('reauth', 'public-x', { institution: { institution_id: 'ins_3', name: 'Chase' } })).toEqual({});
    expect(plaidPayload('add_accounts', 'public-x', {})).toEqual({});
    expect(plaidPayload('create', 'public-x', {})).toEqual({ publicToken: 'public-x' });
  });

  it('reports a closed window as cancelled and a Link error as a launch error', async () => {
    const closed = installPlaid();
    const first = launchPlaid(session({ token: 't' }), context());
    await vi.waitFor(() => expect(closed.handler.open).toHaveBeenCalled());
    optionsOf(closed.create).onExit(null, {});
    await expect(first).resolves.toEqual({ status: 'cancelled' });

    const failing = installPlaid();
    const second = launchPlaid(session({ token: 't' }), context());
    await vi.waitFor(() => expect(failing.handler.open).toHaveBeenCalled());
    optionsOf(failing.create).onExit({ error_message: 'bad', display_message: 'Try another bank' }, {});
    await expect(second).rejects.toMatchObject({ code: 'provider_error', detail: 'Try another bank' });
  });

  it('keeps what the callback route needs for an OAuth bank, and clears it once Link finishes', async () => {
    const { create, handler } = installPlaid();
    const pending = launchPlaid(
      session({ token: 'link-oauth' }),
      context({ connectionId: 'bkc_1', mode: 'reauth', defaultBankAccountId: 'ba_9' }),
    );
    await vi.waitFor(() => expect(handler.open).toHaveBeenCalled());

    expect(readPendingLink()).toMatchObject({
      provider: 'plaid',
      kind: 'plaid_link',
      mode: 'reauth',
      connectionId: 'bkc_1',
      linkToken: 'link-oauth',
      defaultBankAccountId: 'ba_9',
    });

    optionsOf(create).onSuccess('public', {});
    await pending;
    expect(readPendingLink()).toBeNull();
  });

  it('re-opens Link with the received redirect URI after an OAuth bank returns', async () => {
    const { create, handler } = installPlaid();
    const resumed = resumePlaidOAuth({
      linkToken: 'link-oauth',
      mode: 'create',
      receivedRedirectUri: 'https://app.example/weldbooks/banking/feeds/callback?oauth_state_id=abc',
    });
    await vi.waitFor(() => expect(handler.open).toHaveBeenCalled());
    expect(optionsOf(create)).toMatchObject({
      token: 'link-oauth',
      receivedRedirectUri: 'https://app.example/weldbooks/banking/feeds/callback?oauth_state_id=abc',
    });
    optionsOf(create).onSuccess('public-2', {});
    await expect(resumed).resolves.toMatchObject({ status: 'completed', payload: { publicToken: 'public-2' } });
  });

  it('fails without a link token', async () => {
    installPlaid();
    await expect(launchPlaid(session(), context())).rejects.toMatchObject({ code: 'incomplete_session' });
  });
});

describe('Stripe Financial Connections launcher', () => {
  function installStripe(result: unknown) {
    const collect = vi.fn().mockResolvedValue(result);
    loadStripe.mockResolvedValue({ collectFinancialConnectionsAccounts: collect });
    return collect;
  }

  it('collects the accounts with the client secret and returns the session id', async () => {
    vi.stubEnv('VITE_STRIPE_FC_PUBLISHABLE_KEY', 'pk_test_fc');
    const collect = installStripe({ financialConnectionsSession: { id: 'fcsess_1', accounts: [{ id: 'fca_1' }] } });

    const result = await launchStripeFc(session({ provider: 'stripe_fc', kind: 'stripe_fc', clientSecret: 'fcsess_secret' }), context({ provider: 'stripe_fc' }));

    expect(loadStripe).toHaveBeenCalledWith('pk_test_fc');
    expect(collect).toHaveBeenCalledWith({ clientSecret: 'fcsess_secret' });
    expect(result).toEqual({ status: 'completed', payload: { sessionId: 'fcsess_1' } });
  });

  it('treats a closed modal (no accounts) as cancelled', async () => {
    vi.stubEnv('VITE_STRIPE_FC_PUBLISHABLE_KEY', 'pk_test_fc');
    installStripe({ financialConnectionsSession: { id: 'fcsess_1', accounts: [] } });
    const result = await launchStripeFc(session({ kind: 'stripe_fc', clientSecret: 's' }), context());
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('raises Stripe errors as launch errors', async () => {
    vi.stubEnv('VITE_STRIPE_FC_PUBLISHABLE_KEY', 'pk_test_fc');
    installStripe({ error: { message: 'Session expired' } });
    await expect(launchStripeFc(session({ kind: 'stripe_fc', clientSecret: 's' }), context())).rejects.toMatchObject({
      code: 'provider_error',
      detail: 'Session expired',
    });
  });

  it('uses the billing publishable key when no dedicated Financial Connections key is set', () => {
    vi.stubEnv('VITE_STRIPE_FC_PUBLISHABLE_KEY', '');
    vi.stubEnv('VITE_STRIPE_PUBLISHABLE_KEY', 'pk_test_billing');
    expect(stripeFcPublishableKey()).toBe('pk_test_billing');

    vi.stubEnv('VITE_STRIPE_FC_PUBLISHABLE_KEY', 'pk_test_fc');
    expect(stripeFcPublishableKey()).toBe('pk_test_fc');
  });

  it('fails clearly when no publishable key is configured', async () => {
    vi.stubEnv('VITE_STRIPE_FC_PUBLISHABLE_KEY', '');
    vi.stubEnv('VITE_STRIPE_PUBLISHABLE_KEY', '');
    await expect(launchStripeFc(session({ kind: 'stripe_fc', clientSecret: 's' }), context())).rejects.toMatchObject({
      code: 'stripe_not_configured',
    });
    expect(loadStripe).not.toHaveBeenCalled();
  });

  it('fails without a client secret', async () => {
    await expect(launchStripeFc(session({ kind: 'stripe_fc' }), context())).rejects.toBeInstanceOf(BankFeedLaunchError);
  });
});

describe('redirect launcher', () => {
  it('remembers the link and sends the browser to the bank', async () => {
    const url = 'https://auth.ponto.example/authorize?client_id=x&state=state-123';
    const result = await launchRedirect(
      session({ provider: 'ponto', kind: 'redirect', url }),
      context({ provider: 'ponto', returnTo: '/weldbooks/banking/ba_1', defaultBankAccountId: 'ba_1' }),
    );

    expect(result).toEqual({ status: 'redirecting' });
    expect(navigate).toHaveBeenCalledWith(url);
    expect(readPendingLink()).toMatchObject({
      provider: 'ponto',
      kind: 'redirect',
      mode: 'create',
      state: 'state-123',
      returnTo: '/weldbooks/banking/ba_1',
      defaultBankAccountId: 'ba_1',
      redirectUrl: 'https://app.example/weldbooks/banking/feeds/callback',
    });
  });

  it('keeps the connection being repaired', async () => {
    await launchRedirect(
      session({ provider: 'enable_banking', kind: 'redirect', url: 'https://eb.example/auth' }),
      context({ provider: 'enable_banking', mode: 'reauth', connectionId: 'bkc_7' }),
    );
    expect(readPendingLink()).toMatchObject({ provider: 'enable_banking', mode: 'reauth', connectionId: 'bkc_7' });
    expect(readPendingLink()?.state).toBeUndefined();
  });

  it('refuses a link that is not https and a session without one', async () => {
    await expect(
      launchRedirect(session({ kind: 'redirect', url: 'http://evil.example/auth' }), context()),
    ).rejects.toMatchObject({ code: 'insecure_url' });
    await expect(launchRedirect(session({ kind: 'redirect' }), context())).rejects.toMatchObject({
      code: 'incomplete_session',
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(readPendingLink()).toBeNull();
  });
});

describe('pending link', () => {
  const link = {
    provider: 'ponto',
    kind: 'redirect' as const,
    mode: 'create' as const,
    redirectUrl: 'https://app.example/cb',
    returnTo: '/weldbooks/banking/feeds',
  };

  it('expires after an hour and can be cleared', () => {
    const start = Date.now();
    savePendingLink(link, start);
    expect(readPendingLink(start + 59 * 60_000)).toMatchObject({ provider: 'ponto' });
    expect(readPendingLink(start + 61 * 60_000)).toBeNull();

    savePendingLink(link, start);
    clearPendingLink();
    expect(readPendingLink(start)).toBeNull();
  });

  it('ignores malformed storage', () => {
    window.sessionStorage.setItem('weldsuite.bankFeeds.pendingLink', '{"provider":1}');
    expect(readPendingLink()).toBeNull();
    window.sessionStorage.setItem('weldsuite.bankFeeds.pendingLink', 'not json');
    expect(readPendingLink()).toBeNull();
  });

  it('only returns to paths inside WeldBooks', () => {
    expect(safeReturnPath('/weldbooks/banking/ba_1')).toBe('/weldbooks/banking/ba_1');
    expect(safeReturnPath('https://evil.example')).toBe('/weldbooks/banking/feeds');
    expect(safeReturnPath('//evil.example/weldbooks/')).toBe('/weldbooks/banking/feeds');
    expect(safeReturnPath(undefined)).toBe('/weldbooks/banking/feeds');
  });
});
