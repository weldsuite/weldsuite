import { describe, expect, it } from 'vitest';
import { WebhookVerificationError } from '../errors';
import { bankFeedConfigFromEnv, createWebhookProvider } from '../factory';
import { ibanityTestKey, ibanityToken } from '../ibanity-test-utils';
import { jsonResponse, routeFetch, type RecordedCall } from '../test-utils';
import { memoryKeyCache, sha512Base64 } from '../webhook';
import { createPontoProvider, PONTO_REFRESH_POLL_MS, pontoEventsFromWebhook } from './provider';
import { testKey, verifySignature } from './signature-test-utils';

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

const asSignable = (call: RecordedCall) => ({ method: call.method, url: call.url, headers: call.headers, body: call.body ?? undefined });

describe('Ponto link', () => {
  it('builds an authorization-code URL with PKCE and a state that derives the verifier', async () => {
    const provider = createPontoProvider({ ...config, fetch: routeFetch({}).fetch });
    const session = await provider.createLinkSession({ workspaceId: 'ws_1', mode: 'create', historyDays: 365, redirectUrl: 'https://app.example/cb' });

    expect(session.kind).toBe('redirect');
    const url = new URL(session.url ?? '');
    expect(url.origin + url.pathname).toBe('https://authorization.myponto.com/oauth2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
    // offline_access, or Ponto hands out no refresh token.
    expect(url.searchParams.get('scope')).toBe('ai offline_access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  it("sends a sandbox application to the sandbox's authorization page", async () => {
    const { ponto } = bankFeedConfigFromEnv({ PONTO_CLIENT_ID: 'cid', PONTO_CLIENT_SECRET: 'csecret', PONTO_ENV: 'sandbox' });
    const session = await createPontoProvider({ ...config, authorizeUrl: ponto?.authorizeUrl, fetch: routeFetch({}).fetch }).createLinkSession({
      workspaceId: 'ws_1',
      mode: 'create',
      historyDays: 365,
      redirectUrl: 'https://app.example/cb',
    });
    const url = new URL(session.url ?? '');
    expect(url.origin + url.pathname).toBe('https://sandbox-authorization.myponto.com/oauth2/auth');
    const live = bankFeedConfigFromEnv({ PONTO_CLIENT_ID: 'cid', PONTO_CLIENT_SECRET: 'csecret' });
    expect(live.ponto?.authorizeUrl).toBeUndefined();
  });

  it('exchanges the code with the verifier derived from the same state, then lists accounts', async () => {
    let challenge = '';
    const { fetch, calls } = routeFetch({
      'POST /ponto-connect/oauth2/token': { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 1800, token_type: 'bearer' },
      'GET /ponto-connect/userinfo': { sub: 'org_ponto_1' },
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
      metadata: { accountIds: ['acc_1', 'acc_2'], organizationId: 'org_ponto_1' },
    });
    expect(connection.providerConnectionId).toBeTruthy();
    // Indexed by its own id (due syncs) and the organization's (webhooks).
    expect(connection.indexKeys).toEqual([connection.providerConnectionId, 'org_ponto_1']);
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
      'GET /ponto-connect/accounts/acc_1': { data: account('acc_1') },
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

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /ponto-connect/accounts/acc_1',
      'GET /ponto-connect/accounts/acc_1/transactions',
      'GET /ponto-connect/accounts/acc_1/transactions',
    ]);
    expect(calls[0]?.headers.authorization).toBe('Bearer at-1');
    expect(calls[0]?.headers.accept).toBe('application/vnd.api+json');
    expect(result.upserts.map((t) => [t.providerTransactionId, t.amountMinor])).toEqual([
      ['tx_1', -2550],
      ['tx_2', 100000],
    ]);
    expect(result.upserts[0]).toMatchObject({ merchantName: 'Klant NV', description: 'Factuur tx_1', pending: false, currency: 'EUR' });
    expect(result.nextCursor).toEqual({ through: today });
    expect(result.hasMore).toBe(false);
    expect(result.credentials).toBeUndefined();
    expect(result.accountStatuses).toEqual({});
    // The consent end Ponto reports now, not the one the link stored.
    expect(result.consentExpiresAt).toBe('2027-04-01T00:00:00Z');
  });

  it("marks an account whose bank authorization lapsed, and one taken out of the integration, for a reconnect", async () => {
    const lapsed = {
      ...account('acc_1'),
      meta: { latestSynchronization: { type: 'synchronization', attributes: { status: 'error', errors: [{ code: 'authorizationExpired' }] } } },
    };
    const { fetch, calls } = routeFetch({
      'GET /ponto-connect/accounts/acc_1': { data: lapsed },
      'GET /ponto-connect/accounts/acc_1/transactions': { data: [], links: {} },
      'GET /ponto-connect/accounts/acc_2': () => jsonResponse(404, { errors: [{ code: 'resourceNotFound' }] }),
    });
    const provider = createPontoProvider({ ...config, fetch });

    const result = await provider.syncTransactions(stored(freshTokens, { accountIds: ['acc_1', 'acc_2'] }), null);

    expect(result.accountStatuses).toEqual({ acc_1: 'reauth_required', acc_2: 'reauth_required' });
    // No transactions are asked for the account Ponto no longer shares.
    expect(calls.map((c) => c.path)).not.toContain('/ponto-connect/accounts/acc_2/transactions');
  });

  it('refreshes an expired token and hands the rotated tokens back', async () => {
    const { fetch, calls } = routeFetch({
      'POST /ponto-connect/oauth2/token': { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 1800 },
      'GET /ponto-connect/accounts/acc_1': { data: account('acc_1') },
      'GET /ponto-connect/accounts/acc_1/transactions': { data: [], links: {} },
    });
    const provider = createPontoProvider({ ...config, fetch });

    const result = await provider.syncTransactions(stored({ ...freshTokens, expiresAt: new Date(Date.now() - 1000).toISOString() }), null);

    expect(calls[0]?.payload).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1' });
    expect(calls[1]?.headers.authorization).toBe('Bearer at-2');
    expect(result.credentials).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
  });

  it('keeps rotated tokens for the caller when the sync fails after the refresh', async () => {
    const { fetch } = routeFetch({
      'POST /ponto-connect/oauth2/token': { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 1800 },
      'GET /ponto-connect/accounts/acc_1': () => jsonResponse(503, {}),
    });
    const provider = createPontoProvider({ ...config, fetch });

    await expect(provider.syncTransactions(stored({ ...freshTokens, expiresAt: new Date(0).toISOString() }), null)).rejects.toMatchObject({
      kind: 'transient',
    });
    // rt-1 is spent: the caller must store rt-2 or the next sync cannot sign in.
    expect(provider.pendingCredentials('conn_1')).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
    expect(provider.pendingCredentials('conn_other')).toBeUndefined();
  });

  it('maps an invalid refresh token to reauth_required', async () => {
    const { fetch } = routeFetch({ 'POST /ponto-connect/oauth2/token': () => jsonResponse(400, { error: 'invalid_grant' }) });
    const provider = createPontoProvider({ ...config, fetch });
    await expect(
      provider.syncTransactions(stored({ ...freshTokens, expiresAt: new Date(0).toISOString() }), null),
    ).rejects.toMatchObject({ kind: 'reauth_required' });
  });
});

const synchronization = (id: string, status: string, subtype = 'accountTransactions') => ({
  data: { type: 'synchronization', id, attributes: { status, subtype, resourceType: 'account', resourceId: 'acc_1', errors: [] } },
});

describe('Ponto refresh', () => {
  it('asks nothing without the customer, whose IP address Ponto requires', async () => {
    const { fetch, calls } = routeFetch({});
    const provider = createPontoProvider({ ...config, fetch });
    await provider.refresh(stored(freshTokens));
    await provider.refresh(stored(freshTokens), { customerIp: ' ' });
    expect(calls).toHaveLength(0);
  });

  it("starts the balance and transaction synchronizations with the customer's address and waits for them", async () => {
    const waits: number[] = [];
    let looks = 0;
    const { fetch, calls } = routeFetch({
      'POST /ponto-connect/synchronizations': (call) => {
        const subtype = String((call.payload.data as { attributes: { subtype: string } }).attributes.subtype);
        return synchronization(`sync_${subtype}`, 'pending', subtype);
      },
      'GET /ponto-connect/synchronizations/sync_accountDetails': synchronization('sync_accountDetails', 'success', 'accountDetails'),
      'GET /ponto-connect/synchronizations/sync_accountTransactions': () => {
        looks += 1;
        return synchronization('sync_accountTransactions', looks < 2 ? 'running' : 'success');
      },
    });
    const provider = createPontoProvider({ ...config, fetch, sleep: async (ms) => void waits.push(ms) });

    await provider.refresh(stored(freshTokens), { customerIp: '203.0.113.9' });

    expect(calls.filter((c) => c.method === 'POST').map((c) => c.payload)).toEqual([
      {
        data: {
          type: 'synchronization',
          attributes: { resourceType: 'account', resourceId: 'acc_1', subtype: 'accountDetails', customerIpAddress: '203.0.113.9' },
        },
      },
      {
        data: {
          type: 'synchronization',
          attributes: { resourceType: 'account', resourceId: 'acc_1', subtype: 'accountTransactions', customerIpAddress: '203.0.113.9' },
        },
      },
    ]);
    expect(calls[0]?.headers['content-type']).toBe('application/vnd.api+json');
    // Two looks: the transactions were still running at the first.
    expect(waits).toEqual(PONTO_REFRESH_POLL_MS.slice(0, 2));
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.path)).toEqual([
      '/ponto-connect/synchronizations/sync_accountDetails',
      '/ponto-connect/synchronizations/sync_accountTransactions',
      '/ponto-connect/synchronizations/sync_accountTransactions',
    ]);
  });

  it('gives up waiting after 15 seconds, and passes on a refusal only when nothing started', async () => {
    const waits: number[] = [];
    const running = routeFetch({
      'POST /ponto-connect/synchronizations': synchronization('sync_1', 'pending'),
      'GET /ponto-connect/synchronizations/sync_1': synchronization('sync_1', 'running'),
    });
    await createPontoProvider({ ...config, fetch: running.fetch, sleep: async (ms) => void waits.push(ms) }).refresh(stored(freshTokens), {
      customerIp: '203.0.113.9',
    });
    expect(waits).toEqual(PONTO_REFRESH_POLL_MS);

    const tooSoon = routeFetch({
      'POST /ponto-connect/synchronizations': () => jsonResponse(400, { errors: [{ code: 'accountRecentlySynchronized', detail: 'wait' }] }),
    });
    await expect(
      createPontoProvider({ ...config, fetch: tooSoon.fetch, sleep: async () => undefined }).refresh(stored(freshTokens), { customerIp: '203.0.113.9' }),
    ).rejects.toMatchObject({ kind: 'permanent', status: 400 });
  });
});

describe('Ponto balances, disconnect, signatures, webhooks', () => {
  it('reads balances (reusing what the sync read), and revokes the token', async () => {
    const { fetch, calls } = routeFetch({
      'GET /ponto-connect/accounts/acc_1': {
        data: { ...account('acc_1'), meta: { synchronizedAt: '2026-10-09T06:00:00Z' } },
      },
      'GET /ponto-connect/accounts/acc_1/transactions': { data: [], links: {} },
      'POST /ponto-connect/oauth2/revoke': {},
    });
    const provider = createPontoProvider({ ...config, fetch });
    const connection = stored(freshTokens);

    expect((await provider.getBalances(connection))[0]).toMatchObject({
      accountId: 'acc_1',
      current: 150050,
      currency: 'EUR',
      asOf: '2026-10-09T06:00:00Z',
    });
    await provider.syncTransactions(connection, null);
    await provider.getBalances(connection);
    await provider.disconnect(connection);

    // One account read for the sync and the balances that follow it.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /ponto-connect/accounts/acc_1',
      'GET /ponto-connect/accounts/acc_1',
      'GET /ponto-connect/accounts/acc_1/transactions',
      'POST /ponto-connect/oauth2/revoke',
    ]);
    expect(calls[3]?.payload).toMatchObject({ token: 'rt-1' });
    expect(calls[3]?.headers.accept).toBe('application/json');
  });

  it('signs every call with the signature certificate when one is configured', async () => {
    const { privateKey, publicKey } = await testKey();
    const { fetch, calls } = routeFetch({
      'POST /ponto-connect/oauth2/token': { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 1800 },
      'GET /ponto-connect/accounts/acc_1': { data: account('acc_1') },
      'POST /ponto-connect/synchronizations': synchronization('sync_1', 'success'),
      'POST /ponto-connect/oauth2/revoke': {},
    });
    const provider = createPontoProvider({ ...config, fetch, signature: { certificateId: 'cert-1', privateKey } });
    // Expired, so the token is refreshed first.
    const connection = stored({ ...freshTokens, expiresAt: new Date(0).toISOString() });

    await provider.getBalances(connection);
    await provider.refresh(connection, { customerIp: '203.0.113.9' });
    await provider.disconnect(connection);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /ponto-connect/oauth2/token',
      'GET /ponto-connect/accounts/acc_1',
      'POST /ponto-connect/synchronizations',
      'POST /ponto-connect/synchronizations',
      'POST /ponto-connect/oauth2/revoke',
    ]);
    const now = Math.floor(Date.now() / 1000);
    for (const call of calls) {
      const { keyId, created } = await verifySignature(asSignable(call), publicKey);
      expect(keyId).toBe('cert-1');
      expect(Math.abs(created - now)).toBeLessThanOrEqual(60);
    }
  });

  it('sends calls unsigned without a signature certificate, as the sandbox takes them', async () => {
    const { fetch, calls } = routeFetch({ 'GET /ponto-connect/accounts/acc_1': { data: account('acc_1') } });
    const provider = createPontoProvider({ ...config, fetch });
    await provider.getBalances(stored(freshTokens));
    expect(calls[0]?.headers.signature).toBeUndefined();
    expect(calls[0]?.headers.digest).toBeUndefined();
  });

  it('fails a call as an auth error when the signature key is unreadable', async () => {
    const { fetch, calls } = routeFetch({ 'GET /ponto-connect/accounts/acc_1': { data: account('acc_1') } });
    const provider = createPontoProvider({ ...config, fetch, signature: { certificateId: 'cert-1', privateKey: 'not a key' } });
    await expect(provider.getBalances(stored(freshTokens))).rejects.toMatchObject({ provider: 'ponto', kind: 'auth' });
    expect(calls).toHaveLength(0);
  });

  it('has no webhooks without an application id, so a delivery is refused', async () => {
    const provider = createPontoProvider(config);
    await expect(provider.parseWebhook(new Request('https://x', { method: 'POST', body: '{}' }), {})).rejects.toBeInstanceOf(WebhookVerificationError);
    expect(provider.capabilities).toMatchObject({ changeCursor: false, webhooks: false, consentTtlDays: 180 });
  });
});

describe('Ponto webhooks', () => {
  const now = 1_800_000_000_000;
  const delivery = (type: string, relationships: Record<string, unknown> = {}) =>
    JSON.stringify({
      data: {
        type,
        id: 'evt_1',
        attributes: { createdAt: '2027-01-15T08:00:00Z' },
        relationships: { organization: { data: { type: 'organization', id: 'org_ponto_1' } }, ...relationships },
      },
    });
  const onAccount = { account: { data: { type: 'account', id: 'acc_1' } } };

  async function setup() {
    const { privateKey, jwk } = await ibanityTestKey('kid-1');
    const { fetch, calls } = routeFetch({ 'GET /webhooks/keys': { keys: [{ ...jwk, alg: 'RS512', use: 'sig', status: 'ACTIVE' }] } });
    const provider = createPontoProvider({ ...config, applicationId: 'app-1', fetch });
    const send = async (body: string, claims: Record<string, unknown> = {}) =>
      provider.parseWebhook(
        new Request('https://hooks.example/webhooks/bank-feeds/ponto', {
          method: 'POST',
          body,
          headers: {
            Signature: await ibanityToken(privateKey, 'kid-1', { aud: 'app-1', digest: await sha512Base64(body), iat: now / 1000, exp: now / 1000 + 60, ...claims }),
          },
        }),
        { now, keyCache: memoryKeyCache() },
      );
    return { provider, send, calls };
  }

  it('turns on with an application id: verified deliveries, polled once a day', async () => {
    const { provider, send, calls } = await setup();
    expect(provider.capabilities.webhooks).toBe(true);

    expect(await send(delivery('pontoConnect.account.transactionsCreated', onAccount))).toEqual([
      { type: 'sync_available', providerConnectionId: 'org_ponto_1', accountIds: ['acc_1'] },
    ]);
    // The key came from Ibanity's webhooks API, with the application's certificate.
    expect(calls.map((c) => c.url)).toEqual(['https://api.ibanity.com/webhooks/keys']);
    await expect(send(delivery('pontoConnect.account.transactionsCreated', onAccount), { aud: 'app-2' })).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });

  it('maps the events it acts on, and ignores the rest', () => {
    const events = (type: string, relationships: Record<string, unknown> = onAccount) =>
      pontoEventsFromWebhook(JSON.parse(delivery(type, relationships)) as Record<string, unknown>);
    for (const type of [
      'pontoConnect.account.transactionsCreated',
      'pontoConnect.account.transactionsUpdated',
      'pontoConnect.account.detailsUpdated',
      'pontoConnect.account.reauthorized',
      'pontoConnect.synchronization.failed',
    ]) {
      expect(events(type)).toEqual([{ type: 'sync_available', providerConnectionId: 'org_ponto_1', accountIds: ['acc_1'] }]);
    }
    expect(events('pontoConnect.integration.accountRevoked')).toEqual([
      { type: 'reauth_required', providerConnectionId: 'org_ponto_1', accountIds: ['acc_1'], message: 'The account was taken out of the Ponto integration.' },
    ]);
    expect(events('pontoConnect.integration.revoked', {})).toEqual([
      { type: 'revoked', providerConnectionId: 'org_ponto_1', message: 'The Ponto integration was revoked.' },
    ]);
    expect(events('pontoConnect.organization.blocked', {})).toEqual([
      { type: 'error', providerConnectionId: 'org_ponto_1', message: "Ponto blocked the organization; Isabel's service desk can say why." },
    ]);
    expect(events('pontoConnect.organization.unblocked', {})).toEqual([{ type: 'sync_available', providerConnectionId: 'org_ponto_1' }]);
    for (const type of [
      'pontoConnect.synchronization.succeededWithoutChange',
      'pontoConnect.account.pendingTransactionsCreated',
      'pontoConnect.integration.created',
      'pontoConnect.integration.accountAdded',
      'pontoConnect.paymentRequest.closed',
    ]) {
      expect(events(type)).toEqual([]);
    }
    expect(pontoEventsFromWebhook({ data: { type: 'pontoConnect.account.transactionsCreated' } })).toEqual([]);
  });

  it('builds the receiver from the application id alone, without the OAuth client', async () => {
    const { pontoWebhook, ponto } = bankFeedConfigFromEnv({ PONTO_APPLICATION_ID: 'app-1' });
    expect(ponto).toBeUndefined();
    expect(createWebhookProvider('ponto', { pontoWebhook }).capabilities.webhooks).toBe(true);
    const full = bankFeedConfigFromEnv({ PONTO_CLIENT_ID: 'cid', PONTO_CLIENT_SECRET: 'csecret', PONTO_APPLICATION_ID: 'app-1' });
    expect(full.pontoWebhook).toBe(full.ponto);
    expect(bankFeedConfigFromEnv({ PONTO_CLIENT_ID: 'cid', PONTO_CLIENT_SECRET: 'csecret' }).pontoWebhook).toBeUndefined();
  });
});
