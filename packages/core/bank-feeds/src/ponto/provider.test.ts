import { describe, expect, it } from 'vitest';
import { WebhookVerificationError } from '../errors';
import { jsonResponse, routeFetch } from '../test-utils';
import { createPontoProvider } from './provider';

// Shapes follow Ponto Connect's documented JSON:API (hand-written fixtures, not recorded).
const API = 'https://api.ibanity.com/ponto-connect';
const config = { clientId: 'cid', clientSecret: 'csecret' };

function account(id: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'account',
    id,
    attributes: {
      reference: 'BE68539007547034',
      referenceType: 'IBAN',
      currency: 'EUR',
      description: 'Zakelijke rekening',
      holderName: 'Weld BV',
      subtype: 'checking',
      currentBalance: 1500.5,
      availableBalance: 1400,
      synchronizedAt: '2026-10-08T06:00:00Z',
      authorizationExpirationExpectedAt: '2027-04-01T00:00:00Z',
      ...overrides,
    },
    relationships: { financialInstitution: { data: { type: 'financialInstitution', id: 'fi_kbc' } } },
  };
}

function tx(id: string, executionDate: string, amount: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'transaction',
    id,
    attributes: { executionDate, valueDate: executionDate, amount, currency: 'EUR', counterpartName: 'Klant NV', remittanceInformation: `Factuur ${id}`, ...extra },
  };
}

const stored = (credentials: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  provider: 'ponto',
  providerConnectionId: 'conn_1',
  credentials,
  cursor: null,
  metadata: { accountIds: ['acc_1'] },
  historyDays: 90,
  ...extra,
});

const freshTokens = { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };

describe('Ponto link', () => {
  it('builds an authorization-code URL with PKCE and a state that derives the verifier', async () => {
    const provider = createPontoProvider({ ...config, fetch: routeFetch({}).fetch });
    const session = await provider.createLinkSession({ workspaceId: 'ws_1', mode: 'create', historyDays: 365, redirectUrl: 'https://app.example/cb' });

    expect(session.kind).toBe('redirect');
    const url = new URL(session.url ?? '');
    expect(url.origin + url.pathname).toBe('https://authorization.myponto.com/oauth2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('exchanges the code with the verifier derived from the same state, then lists accounts', async () => {
    let challenge = '';
    const { fetch, calls } = routeFetch({
      'POST /ponto-connect/oauth2/token': { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 1800, token_type: 'bearer' },
      'GET /ponto-connect/accounts': { data: [account('acc_1'), account('acc_2', { reference: 'BE71096123456769', description: 'Spaar', subtype: 'savings' })], links: {} },
    });
    const provider = createPontoProvider({ ...config, fetch });
    const session = await provider.createLinkSession({ workspaceId: 'ws_1', mode: 'create', historyDays: 365, redirectUrl: 'https://app.example/cb' });
    const url = new URL(session.url ?? '');
    const state = url.searchParams.get('state') ?? '';
    challenge = url.searchParams.get('code_challenge') ?? '';

    const { connection, accounts } = await provider.completeLink({ code: 'auth-code', state, redirectUrl: 'https://app.example/cb' });

    const tokenCall = calls[0];
    expect(tokenCall?.headers.authorization).toBe(`Basic ${btoa('cid:csecret')}`);
    expect(tokenCall?.payload).toMatchObject({ grant_type: 'authorization_code', code: 'auth-code', redirect_uri: 'https://app.example/cb' });
    // S256(verifier) must equal the challenge sent when the link started.
    const verifier = String(tokenCall?.payload.code_verifier);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    expect(btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')).toBe(challenge);

    expect(connection).toMatchObject({
      provider: 'ponto',
      status: 'active',
      consentExpiresAt: '2027-04-01T00:00:00Z',
      credentials: { accessToken: 'at-1', refreshToken: 'rt-1' },
      metadata: { accountIds: ['acc_1', 'acc_2'] },
    });
    expect(connection.providerConnectionId).toBeTruthy();
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ type: 'depository', subtype: 'checking', iban: 'BE68539007547034', mask: '7034', currency: 'EUR', institutionId: 'fi_kbc' });
    expect(accounts[0]?.balance).toMatchObject({ current: 150050, available: 140000 });
    expect(accounts[0]?.fingerprint).not.toBe(accounts[1]?.fingerprint);
  });
});

describe('Ponto sync', () => {
  it('re-pulls the window, keeps signed amounts, and stops once a page falls below it', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const inWindow = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const { fetch, calls } = routeFetch({
      'GET /ponto-connect/accounts/acc_1/transactions': (call) =>
        call.query.get('page[after]') === 'tx_2'
          ? { data: [tx('tx_3', inWindow(200), -10)], links: {} }
          : {
              data: [tx('tx_1', today, -25.5), tx('tx_2', inWindow(5), 1000)],
              links: { next: `${API}/accounts/acc_1/transactions?page[limit]=100&page[after]=tx_2` },
            },
    });
    const provider = createPontoProvider({ ...config, fetch });

    const result = await provider.syncTransactions(stored(freshTokens), null);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.authorization).toBe('Bearer at-1');
    expect(result.upserts.map((t) => [t.providerTransactionId, t.amountMinor])).toEqual([
      ['tx_1', -2550],
      ['tx_2', 100000],
    ]);
    expect(result.upserts[0]).toMatchObject({ merchantName: 'Klant NV', description: 'Factuur tx_1', pending: false, currency: 'EUR' });
    expect(result.nextCursor).toEqual({ through: today });
    expect(result.hasMore).toBe(false);
    expect(result.credentials).toBeUndefined();
  });

  it('refreshes an expired token and hands the rotated tokens back', async () => {
    const { fetch, calls } = routeFetch({
      'POST /ponto-connect/oauth2/token': { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 1800 },
      'GET /ponto-connect/accounts/acc_1/transactions': { data: [], links: {} },
    });
    const provider = createPontoProvider({ ...config, fetch });

    const result = await provider.syncTransactions(stored({ ...freshTokens, expiresAt: new Date(Date.now() - 1000).toISOString() }), null);

    expect(calls[0]?.payload).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1' });
    expect(calls[1]?.headers.authorization).toBe('Bearer at-2');
    expect(result.credentials).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
  });

  it('maps an invalid refresh token to reauth_required', async () => {
    const { fetch } = routeFetch({ 'POST /ponto-connect/oauth2/token': () => jsonResponse(400, { error: 'invalid_grant' }) });
    const provider = createPontoProvider({ ...config, fetch });
    await expect(
      provider.syncTransactions(stored({ ...freshTokens, expiresAt: new Date(0).toISOString() }), null),
    ).rejects.toMatchObject({ kind: 'reauth_required' });
  });
});

describe('Ponto balances, refresh, disconnect, webhooks', () => {
  it('reads balances, requests a synchronization, and revokes the token', async () => {
    const { fetch, calls } = routeFetch({
      'GET /ponto-connect/accounts/acc_1': { data: account('acc_1') },
      'POST /ponto-connect/synchronizations': {},
      'POST /ponto-connect/oauth2/revoke': {},
    });
    const provider = createPontoProvider({ ...config, fetch });
    const connection = stored(freshTokens);

    expect((await provider.getBalances(connection))[0]).toMatchObject({ accountId: 'acc_1', current: 150050, currency: 'EUR' });
    await provider.refresh?.(connection);
    await provider.disconnect(connection);

    expect(calls[1]?.payload).toMatchObject({ data: { type: 'synchronization', attributes: { resourceType: 'account', resourceId: 'acc_1', subtype: 'accountTransactions' } } });
    expect(calls[2]?.payload).toMatchObject({ token: 'rt-1' });
  });

  it('has no webhooks, so a delivery is refused', async () => {
    const provider = createPontoProvider(config);
    await expect(provider.parseWebhook(new Request('https://x', { method: 'POST', body: '{}' }), {})).rejects.toBeInstanceOf(WebhookVerificationError);
    expect(provider.capabilities).toMatchObject({ changeCursor: false, webhooks: false, consentTtlDays: 180 });
  });
});
