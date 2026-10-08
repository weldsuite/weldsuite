import { describe, expect, it } from 'vitest';
import { FeedProviderError, WebhookVerificationError } from '../errors';
import { utf8 } from '../http';
import { sha256Hex } from '../normalize';
import { bytesToBase64Url, jsonResponse, routeFetch } from '../test-utils';
import { memoryKeyCache } from '../webhook';
import { createPlaidProvider, plaidEventsFromWebhook } from './provider';

// Response shapes follow Plaid's documented API (hand-written fixtures, not recorded).
const ACCOUNTS_RESPONSE = {
  accounts: [
    {
      account_id: 'acc_checking',
      balances: { available: 1200.5, current: 1300.75, iso_currency_code: 'USD', limit: null },
      mask: '0000',
      name: 'Plaid Checking',
      official_name: 'Plaid Gold Standard 0% Interest Checking',
      subtype: 'checking',
      type: 'depository',
    },
    {
      account_id: 'acc_card',
      balances: { available: 7500, current: 2500.25, iso_currency_code: 'USD', limit: 10000 },
      mask: '3333',
      name: 'Plaid Credit Card',
      official_name: 'Plaid Diamond 12.5% APR Interest Credit Card',
      subtype: 'credit card',
      type: 'credit',
    },
    {
      account_id: 'acc_brokerage',
      balances: { available: null, current: 100, iso_currency_code: 'USD' },
      mask: '1111',
      name: 'Plaid IRA',
      subtype: 'ira',
      type: 'investment',
    },
  ],
  item: { item_id: 'item_1', institution_id: 'ins_109508', consent_expiration_time: '2027-01-01T00:00:00Z', error: null },
};

function txn(overrides: Record<string, unknown>) {
  return {
    transaction_id: 't1',
    account_id: 'acc_checking',
    amount: 12.34,
    iso_currency_code: 'USD',
    date: '2026-10-01',
    name: 'Starbucks',
    merchant_name: 'Starbucks',
    pending: false,
    pending_transaction_id: null,
    check_number: null,
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE', confidence_level: 'HIGH' },
    ...overrides,
  };
}

const config = { clientId: 'cid', secret: 'sec', env: 'sandbox' as const, webhookUrl: 'https://hooks.example/webhooks/bank-feeds/plaid' };

describe('Plaid link', () => {
  it('creates a link token for new links: transactions only, 730 days, accounts filtered, webhook set', async () => {
    const { fetch, calls } = routeFetch({ 'POST /link/token/create': { link_token: 'link-sandbox-1', expiration: '2026-10-08T12:00:00Z' } });
    const provider = createPlaidProvider({ ...config, fetch });

    const session = await provider.createLinkSession({
      workspaceId: 'ws_1',
      mode: 'create',
      historyDays: 9999,
      redirectUrl: 'https://app.example/weldbooks/banking/callback',
    });

    expect(session).toEqual({ kind: 'plaid_link', token: 'link-sandbox-1', expiresAt: '2026-10-08T12:00:00Z' });
    expect(calls[0]?.url).toBe('https://sandbox.plaid.com/link/token/create');
    expect(calls[0]?.payload).toMatchObject({
      client_id: 'cid',
      secret: 'sec',
      user: { client_user_id: 'ws_1' },
      products: ['transactions'],
      transactions: { days_requested: 730 },
      webhook: 'https://hooks.example/webhooks/bank-feeds/plaid',
      account_filters: { depository: { account_subtypes: ['all'] }, credit: { account_subtypes: ['all'] } },
    });
    expect(calls[0]?.payload.access_token).toBeUndefined();
    // An unregistered redirect_uri would fail the link, so it is only sent when configured.
    expect(calls[0]?.payload.redirect_uri).toBeUndefined();
  });

  it('sends the registered OAuth redirect URI when one is configured', async () => {
    const { fetch, calls } = routeFetch({ 'POST /link/token/create': { link_token: 'link-1' } });
    const provider = createPlaidProvider({ ...config, redirectUri: 'https://app.example/oauth-return', fetch });
    await provider.createLinkSession({ workspaceId: 'ws_1', mode: 'create', historyDays: 90, redirectUrl: 'https://app.example/other' });
    expect(calls[0]?.payload.redirect_uri).toBe('https://app.example/oauth-return');
    expect((calls[0]?.payload.transactions as { days_requested: number }).days_requested).toBe(90);
  });

  it('uses update mode with the access token for reauth and account selection for add_accounts', async () => {
    const { fetch, calls } = routeFetch({ 'POST /link/token/create': { link_token: 'link-update-1' } });
    const provider = createPlaidProvider({ ...config, fetch });
    const connection = { provider: 'plaid', providerConnectionId: 'item_1', credentials: { accessToken: 'access-1' }, cursor: null, metadata: {} };

    await provider.createLinkSession({ workspaceId: 'ws_1', mode: 'reauth', historyDays: 730, redirectUrl: 'https://app.example/cb', connection });
    await provider.createLinkSession({ workspaceId: 'ws_1', mode: 'add_accounts', historyDays: 730, redirectUrl: 'https://app.example/cb', connection });

    expect(calls[0]?.payload).toMatchObject({ access_token: 'access-1' });
    expect(calls[0]?.payload.products).toBeUndefined();
    expect(calls[0]?.payload.update).toBeUndefined();
    expect(calls[1]?.payload).toMatchObject({ access_token: 'access-1', update: { account_selection_enabled: true } });
  });

  it('exchanges the public token and maps accounts (investments skipped, card balance negative)', async () => {
    const { fetch, calls } = routeFetch({
      'POST /item/public_token/exchange': { access_token: 'access-sandbox-1', item_id: 'item_1' },
      'POST /accounts/get': ACCOUNTS_RESPONSE,
    });
    const provider = createPlaidProvider({ ...config, fetch });

    const { connection, accounts } = await provider.completeLink({
      publicToken: 'public-sandbox-1',
      institution: { institutionId: 'ins_109508', name: 'First Platypus Bank' },
    });

    expect(calls[0]?.payload).toMatchObject({ public_token: 'public-sandbox-1' });
    expect(connection).toMatchObject({
      provider: 'plaid',
      providerConnectionId: 'item_1',
      institutionName: 'First Platypus Bank',
      status: 'active',
      credentials: { accessToken: 'access-sandbox-1' },
      consentExpiresAt: '2027-01-01T00:00:00Z',
    });
    expect(accounts.map((a) => a.providerAccountId)).toEqual(['acc_checking', 'acc_card']);
    expect(accounts[0]).toMatchObject({ type: 'depository', subtype: 'checking', mask: '0000', currency: 'USD' });
    expect(accounts[0]?.balance).toMatchObject({ current: 130075, available: 120050 });
    expect(accounts[1]).toMatchObject({ type: 'credit', subtype: 'credit_card' });
    expect(accounts[1]?.balance).toMatchObject({ current: -250025, available: 750000, limit: 1000000 });
    expect(accounts[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(accounts[0]?.fingerprint).not.toBe(accounts[1]?.fingerprint);
  });

  it('completes an update-mode link without exchanging a token', async () => {
    const { fetch, calls } = routeFetch({ 'POST /accounts/get': ACCOUNTS_RESPONSE, 'POST /institutions/get_by_id': { institution: { name: 'First Platypus Bank' } } });
    const provider = createPlaidProvider({ ...config, fetch });
    const stored = { provider: 'plaid', providerConnectionId: 'item_1', credentials: { accessToken: 'access-1' }, cursor: 'cursor-9', metadata: {} };

    const { connection } = await provider.completeLink({ connection: stored });

    expect(calls.map((c) => c.path)).toEqual(['/accounts/get', '/institutions/get_by_id']);
    expect(connection).toMatchObject({ providerConnectionId: 'item_1', cursor: 'cursor-9', status: 'active', institutionName: 'First Platypus Bank' });
  });
});

describe('Plaid sync', () => {
  const connection = { provider: 'plaid', providerConnectionId: 'item_1', credentials: { accessToken: 'access-1' }, cursor: null, metadata: {} };

  it('negates amounts, links pending to posted, and treats modified as upsert', async () => {
    const { fetch, calls } = routeFetch({
      'POST /transactions/sync': {
        added: [
          txn({ transaction_id: 'purchase', amount: 12.34 }),
          txn({ transaction_id: 'deposit', amount: -2500, name: 'ACH Payroll', merchant_name: null }),
          txn({ transaction_id: 'pending_1', amount: 40, pending: true, name: 'Hotel hold' }),
          txn({ transaction_id: 'check_1', amount: 100, name: 'Check 1042', check_number: '1042' }),
        ],
        modified: [txn({ transaction_id: 'posted_1', amount: 42.5, pending_transaction_id: 'pending_0', date: '2026-10-03' })],
        removed: [{ transaction_id: 'pending_0' }],
        next_cursor: 'cursor-2',
        has_more: true,
      },
    });
    const provider = createPlaidProvider({ ...config, fetch });

    const result = await provider.syncTransactions(connection, null);

    expect(calls[0]?.payload.cursor).toBeUndefined();
    expect(calls[0]?.payload).toMatchObject({ access_token: 'access-1', count: 500 });
    expect(result.nextCursor).toBe('cursor-2');
    expect(result.hasMore).toBe(true);
    expect(result.removals).toEqual(['pending_0']);

    const byId = Object.fromEntries(result.upserts.map((t) => [t.providerTransactionId, t]));
    expect(byId.purchase).toMatchObject({ amountMinor: -1234, date: '2026-10-01', pending: false, merchantName: 'Starbucks', currency: 'USD' });
    expect(byId.deposit?.amountMinor).toBe(250000);
    expect(byId.pending_1).toMatchObject({ pending: true, amountMinor: -4000 });
    expect(byId.check_1).toMatchObject({ checkNumber: '1042', amountMinor: -10000 });
    expect(byId.posted_1).toMatchObject({ pendingTransactionId: 'pending_0', amountMinor: -4250, pending: false });
    expect(byId.purchase?.category).toMatchObject({ source: 'plaid', primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' });
  });

  it('sends the stored cursor and follows has_more to the end', async () => {
    const { fetch, calls } = routeFetch({ 'POST /transactions/sync': { added: [], modified: [], removed: [], next_cursor: 'cursor-3', has_more: false } });
    const provider = createPlaidProvider({ ...config, fetch });

    const result = await provider.syncTransactions(connection, 'cursor-2');

    expect(calls[0]?.payload.cursor).toBe('cursor-2');
    expect(result).toMatchObject({ nextCursor: 'cursor-3', hasMore: false, upserts: [], removals: [] });
  });

  it('keeps the cursor when the first pull is not ready', async () => {
    const { fetch } = routeFetch({
      'POST /transactions/sync': () => jsonResponse(400, { error_type: 'ITEM_ERROR', error_code: 'PRODUCT_NOT_READY', error_message: 'not ready' }),
    });
    const provider = createPlaidProvider({ ...config, fetch });
    expect(await provider.syncTransactions(connection, null)).toEqual({ upserts: [], removals: [], nextCursor: null, hasMore: false });
  });

  it('surfaces mutation-during-pagination, login-required and rate limits as typed errors', async () => {
    const cases: Array<[string, number, string]> = [
      ['TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 400, 'mutation_during_pagination'],
      ['ITEM_LOGIN_REQUIRED', 400, 'reauth_required'],
      ['RATE_LIMIT_EXCEEDED', 429, 'rate_limit'],
    ];
    for (const [code, status, kind] of cases) {
      const { fetch } = routeFetch({ 'POST /transactions/sync': () => jsonResponse(status, { error_code: code, error_message: 'x' }) });
      const provider = createPlaidProvider({ ...config, fetch });
      await expect(provider.syncTransactions(connection, 'c')).rejects.toMatchObject({ kind, code });
    }
  });

  it('never puts credentials in error messages', async () => {
    const { fetch } = routeFetch({ 'POST /transactions/sync': () => jsonResponse(500, {}) });
    const provider = createPlaidProvider({ ...config, fetch });
    const err = await provider.syncTransactions(connection, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeedProviderError);
    expect(String((err as Error).message)).not.toContain('sec');
    expect(String((err as Error).message)).not.toContain('access-1');
  });
});

describe('Plaid balances, refresh and disconnect', () => {
  const connection = { provider: 'plaid', providerConnectionId: 'item_1', credentials: { accessToken: 'access-1' }, cursor: null, metadata: {} };

  it('reads cached balances from /accounts/get by default', async () => {
    const { fetch, calls } = routeFetch({ 'POST /accounts/get': ACCOUNTS_RESPONSE });
    const balances = await createPlaidProvider({ ...config, fetch }).getBalances(connection);
    expect(calls[0]?.path).toBe('/accounts/get');
    expect(balances.map((b) => [b.accountId, b.current])).toEqual([
      ['acc_checking', 130075],
      ['acc_card', -250025],
    ]);
  });

  it('uses real-time balances only when configured', async () => {
    const { fetch, calls } = routeFetch({ 'POST /accounts/balance/get': ACCOUNTS_RESPONSE });
    await createPlaidProvider({ ...config, realtimeBalance: true, fetch }).getBalances(connection);
    expect(calls[0]?.path).toBe('/accounts/balance/get');
  });

  it('refreshes and removes the item (which ends billing), tolerating an already-removed item', async () => {
    const { fetch, calls } = routeFetch({ 'POST /transactions/refresh': {}, 'POST /item/remove': {} });
    const provider = createPlaidProvider({ ...config, fetch });
    await provider.refresh?.(connection);
    await provider.disconnect(connection);
    expect(calls.map((c) => c.path)).toEqual(['/transactions/refresh', '/item/remove']);

    const gone = routeFetch({ 'POST /item/remove': () => jsonResponse(400, { error_code: 'ITEM_NOT_FOUND', error_message: 'gone' }) });
    await expect(createPlaidProvider({ ...config, fetch: gone.fetch }).disconnect(connection)).resolves.toBeUndefined();
  });
});

describe('Plaid webhooks', () => {
  it('maps deliveries to events', () => {
    expect(plaidEventsFromWebhook({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item_1' })).toEqual([
      { type: 'sync_available', providerConnectionId: 'item_1' },
    ]);
    expect(
      plaidEventsFromWebhook({ webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'item_1', error: { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login' } }),
    ).toEqual([{ type: 'reauth_required', providerConnectionId: 'item_1', message: 'login' }]);
    expect(plaidEventsFromWebhook({ webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'item_1', error: { error_code: 'INTERNAL_SERVER_ERROR' } })[0]?.type).toBe('error');
    expect(plaidEventsFromWebhook({ webhook_type: 'ITEM', webhook_code: 'PENDING_DISCONNECT', item_id: 'item_1' })[0]).toMatchObject({ type: 'expiring' });
    expect(plaidEventsFromWebhook({ webhook_type: 'ITEM', webhook_code: 'PENDING_EXPIRATION', item_id: 'item_1', consent_expiration_time: '2026-11-01T00:00:00Z' })[0]).toMatchObject({
      type: 'expiring',
      expiresAt: '2026-11-01T00:00:00Z',
    });
    expect(plaidEventsFromWebhook({ webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED', item_id: 'item_1' })).toEqual([{ type: 'revoked', providerConnectionId: 'item_1' }]);
    expect(plaidEventsFromWebhook({ webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE', item_id: 'item_1' })).toEqual([]);
    expect(plaidEventsFromWebhook({ webhook_type: 'HOLDINGS', webhook_code: 'DEFAULT_UPDATE', item_id: 'item_1' })).toEqual([]);
  });

  async function signedDelivery(body: string, tamper = false) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const now = 1_800_000_000_000;
    const header = bytesToBase64Url(utf8(JSON.stringify({ alg: 'ES256', kid: 'kid-9', typ: 'JWT' })));
    const claims = bytesToBase64Url(utf8(JSON.stringify({ iat: now / 1000, request_body_sha256: await sha256Hex(tamper ? `${body} ` : body) })));
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, utf8(`${header}.${claims}`));
    const { fetch, calls } = routeFetch({
      'POST /webhook_verification_key/get': { key: { alg: 'ES256', crv: 'P-256', kid: 'kid-9', kty: 'EC', x: jwk.x, y: jwk.y, expired_at: null } },
    });
    return {
      fetch,
      calls,
      now,
      request: new Request('https://hooks.example/webhooks/bank-feeds/plaid', {
        method: 'POST',
        body,
        headers: { 'Plaid-Verification': `${header}.${claims}.${bytesToBase64Url(new Uint8Array(signature))}` },
      }),
    };
  }

  it('verifies the JWT against the fetched key and returns events', async () => {
    const body = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item_7', initial_update_complete: true });
    const delivery = await signedDelivery(body);
    const provider = createPlaidProvider({ ...config, fetch: delivery.fetch });

    const events = await provider.parseWebhook(delivery.request, { keyCache: memoryKeyCache(), now: delivery.now });

    expect(events).toEqual([{ type: 'sync_available', providerConnectionId: 'item_7' }]);
    expect(delivery.calls[0]?.payload).toMatchObject({ key_id: 'kid-9' });
  });

  it('refuses a delivery whose body was altered after signing', async () => {
    const body = JSON.stringify({ webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED', item_id: 'item_7' });
    const delivery = await signedDelivery(body, true);
    const provider = createPlaidProvider({ ...config, fetch: delivery.fetch });
    await expect(provider.parseWebhook(delivery.request, { keyCache: memoryKeyCache(), now: delivery.now })).rejects.toBeInstanceOf(WebhookVerificationError);
  });
});
