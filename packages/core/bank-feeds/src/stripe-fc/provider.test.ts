import { describe, expect, it } from 'vitest';
import { WebhookVerificationError } from '../errors';
import { jsonResponse, routeFetch } from '../test-utils';
import { buildStripeSignatureHeader } from '../webhook';
import { createStripeFcProvider, stripeFcEventsFromWebhook } from './provider';

// Response shapes follow Stripe's documented FC API (hand-written fixtures, not recorded).
function fcAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fca_1',
    object: 'financial_connections.account',
    category: 'cash',
    subcategory: 'checking',
    display_name: 'Business Checking',
    institution_name: 'Chase',
    last4: '6789',
    status: 'active',
    permissions: ['transactions', 'balances'],
    subscriptions: [],
    balance: { as_of: 1_790_000_000, type: 'cash', cash: { available: { usd: 150000 } }, current: { usd: 160000 } },
    transaction_refresh: { id: 'fctxnref_2', status: 'succeeded', last_attempted_at: 1_790_000_000 },
    ...overrides,
  };
}

function fcTxn(overrides: Record<string, unknown>) {
  return {
    id: 'fctxn_1',
    object: 'financial_connections.transaction',
    account: 'fca_1',
    amount: -1234,
    currency: 'usd',
    description: 'STARBUCKS #1234',
    status: 'posted',
    status_transitions: { posted_at: 1_790_100_000, void_at: null },
    transacted_at: 1_790_000_000,
    ...overrides,
  };
}

const config = { secretKey: 'sk_test_fc' };
const stored = (extra: Record<string, unknown> = {}) => ({
  provider: 'stripe_fc',
  providerConnectionId: 'fcsess_1',
  credentials: { accountHolderId: 'cus_1' },
  cursor: null,
  metadata: { accountIds: ['fca_1'] },
  ...extra,
});

describe('Stripe FC link', () => {
  it('finds the workspace customer by metadata, then creates the session with form encoding', async () => {
    const { fetch, calls } = routeFetch({
      'GET /v1/customers/search': { data: [{ id: 'cus_existing' }] },
      'POST /v1/financial_connections/sessions': { id: 'fcsess_1', client_secret: 'fcsess_secret_1' },
    });
    const provider = createStripeFcProvider({ ...config, fetch });

    const session = await provider.createLinkSession({ workspaceId: 'ws_1', mode: 'create', historyDays: 180, redirectUrl: 'https://app.example/cb' });

    expect(session).toEqual({ kind: 'stripe_fc', clientSecret: 'fcsess_secret_1', sessionId: 'fcsess_1' });
    expect(calls[0]?.query.get('query')).toBe("metadata['weldsuite_workspace']:'ws_1'");
    expect(calls[1]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[1]?.headers['stripe-version']).toBe('2025-11-17.clover');
    expect(calls[1]?.headers.authorization).toBe(`Basic ${btoa('sk_test_fc:')}`);
    expect(calls[1]?.payload).toMatchObject({
      'account_holder[type]': 'customer',
      'account_holder[customer]': 'cus_existing',
      'permissions[0]': 'transactions',
      'permissions[1]': 'balances',
      'prefetch[0]': 'transactions',
      'filters[countries][0]': 'US',
      return_url: 'https://app.example/cb',
    });
  });

  it('creates the customer (idempotently) when none exists', async () => {
    const { fetch, calls } = routeFetch({
      'GET /v1/customers/search': { data: [] },
      'POST /v1/customers': { id: 'cus_new' },
      'POST /v1/financial_connections/sessions': { id: 'fcsess_1', client_secret: 's' },
    });
    await createStripeFcProvider({ ...config, fetch }).createLinkSession({ workspaceId: 'ws_9', mode: 'create', historyDays: 180, redirectUrl: 'https://app.example/cb' });

    expect(calls[1]?.headers['idempotency-key']).toBe('weldsuite-bank-feeds-customer-ws_9');
    expect(calls[1]?.payload).toMatchObject({ 'metadata[weldsuite_workspace]': 'ws_9' });
    expect(calls[2]?.payload).toMatchObject({ 'account_holder[customer]': 'cus_new' });
  });

  it('reuses the stored account holder on reauth', async () => {
    const { fetch, calls } = routeFetch({ 'POST /v1/financial_connections/sessions': { id: 'fcsess_2', client_secret: 's' } });
    await createStripeFcProvider({ ...config, fetch }).createLinkSession({
      workspaceId: 'ws_1',
      mode: 'reauth',
      historyDays: 180,
      redirectUrl: 'https://app.example/cb',
      connection: stored(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({ 'account_holder[customer]': 'cus_1' });
  });

  it('collects the session accounts, subscribes to transactions and rolls up per-account status', async () => {
    const { fetch, calls } = routeFetch({
      'GET /v1/financial_connections/sessions/fcsess_1': {
        id: 'fcsess_1',
        account_holder: { type: 'customer', customer: 'cus_1' },
        accounts: {
          data: [
            fcAccount(),
            fcAccount({ id: 'fca_card', category: 'credit', subcategory: 'credit_card', display_name: 'Sapphire', last4: '4242', subscriptions: ['transactions'], balance: { as_of: 1_790_000_000, type: 'credit', credit: { used: { usd: 50000 } }, current: { usd: 50000 } } }),
            fcAccount({ id: 'fca_invest', category: 'investment', subcategory: 'other' }),
          ],
          has_more: false,
        },
      },
      'POST /v1/financial_connections/accounts/fca_1/subscribe': {},
    });
    const provider = createStripeFcProvider({ ...config, fetch });

    const { connection, accounts } = await provider.completeLink({ sessionId: 'fcsess_1' });

    expect(accounts.map((a) => a.providerAccountId)).toEqual(['fca_1', 'fca_card']);
    expect(accounts[0]).toMatchObject({ type: 'depository', subtype: 'checking', mask: '6789', institutionName: 'Chase', currency: 'USD' });
    expect(accounts[1]).toMatchObject({ type: 'credit', subtype: 'credit_card' });
    expect(accounts[1]?.balance?.current).toBe(-50000); // owed amount signs as a liability
    expect(calls.filter((c) => c.path.endsWith('/subscribe')).map((c) => c.path)).toEqual(['/v1/financial_connections/accounts/fca_1/subscribe']);
    expect(connection).toMatchObject({
      provider: 'stripe_fc',
      providerConnectionId: 'fcsess_1',
      indexKeys: ['fca_1', 'fca_card'],
      status: 'active',
      credentials: { accountHolderId: 'cus_1' },
      metadata: { accountIds: ['fca_1', 'fca_card'] },
    });
  });

  it('merges the new accounts into the stored connection on add_accounts', async () => {
    const { fetch } = routeFetch({
      'GET /v1/financial_connections/sessions/fcsess_2': { id: 'fcsess_2', account_holder: { customer: 'cus_1' }, accounts: { data: [fcAccount({ id: 'fca_2', subscriptions: ['transactions'] })], has_more: false } },
    });
    const { connection } = await createStripeFcProvider({ ...config, fetch }).completeLink({ sessionId: 'fcsess_2', connection: stored() });
    expect(connection.providerConnectionId).toBe('fcsess_1');
    expect(connection.indexKeys).toEqual(['fca_1', 'fca_2']);
  });
});

describe('Stripe FC sync', () => {
  it('reads transactions since the last refresh, maps status, and advances the watermark', async () => {
    const { fetch, calls } = routeFetch({
      'GET /v1/financial_connections/accounts/fca_1': fcAccount(),
      'GET /v1/financial_connections/transactions': (call) =>
        call.query.get('starting_after')
          ? { data: [fcTxn({ id: 'fctxn_3', amount: 99900, description: 'PAYROLL', status_transitions: { posted_at: 1_790_100_000 } })], has_more: false }
          : {
              data: [
                fcTxn({ id: 'fctxn_1', amount: -1234 }),
                fcTxn({ id: 'fctxn_2', amount: -5000, status: 'pending', status_transitions: {}, description: 'HOTEL HOLD' }),
                fcTxn({ id: 'fctxn_void', status: 'void', status_transitions: { void_at: 1_790_200_000 } }),
              ],
              has_more: true,
            },
    });
    const provider = createStripeFcProvider({ ...config, fetch });

    const result = await provider.syncTransactions(stored(), { refreshIds: { fca_1: 'fctxnref_1' } });

    const list = calls.filter((c) => c.path === '/v1/financial_connections/transactions');
    expect(list).toHaveLength(2);
    expect(list[0]?.query.get('transaction_refresh[after]')).toBe('fctxnref_1');
    expect(list[0]?.query.get('account')).toBe('fca_1');
    expect(list[1]?.query.get('starting_after')).toBe('fctxn_void');
    expect(result.hasMore).toBe(false);
    expect(result.removals).toEqual(['fctxn_void']);
    expect(result.nextCursor).toEqual({ refreshIds: { fca_1: 'fctxnref_2' } });
    expect(result.accountStatuses).toEqual({ fca_1: 'active' });

    const byId = Object.fromEntries(result.upserts.map((t) => [t.providerTransactionId, t]));
    expect(byId.fctxn_1).toMatchObject({ amountMinor: -1234, pending: false, currency: 'USD', description: 'STARBUCKS #1234' });
    expect(byId.fctxn_1?.date).toBe(new Date(1_790_100_000 * 1000).toISOString().slice(0, 10));
    expect(byId.fctxn_2).toMatchObject({ pending: true, amountMinor: -5000 });
    expect(byId.fctxn_3?.amountMinor).toBe(99900); // money in stays positive: FC already uses the statement convention
  });

  it('skips an account whose latest refresh was already read', async () => {
    const { fetch, calls } = routeFetch({ 'GET /v1/financial_connections/accounts/fca_1': fcAccount() });
    const result = await createStripeFcProvider({ ...config, fetch }).syncTransactions(stored(), { refreshIds: { fca_1: 'fctxnref_2' } });
    expect(calls).toHaveLength(1);
    expect(result.upserts).toEqual([]);
    expect(result.nextCursor).toEqual({ refreshIds: { fca_1: 'fctxnref_2' } });
  });

  it('waits for a pending refresh and does not move the watermark', async () => {
    const { fetch } = routeFetch({ 'GET /v1/financial_connections/accounts/fca_1': fcAccount({ transaction_refresh: { id: 'fctxnref_3', status: 'pending' } }) });
    const result = await createStripeFcProvider({ ...config, fetch }).syncTransactions(stored(), null);
    expect(result.upserts).toEqual([]);
    expect(result.nextCursor).toEqual({ refreshIds: {} });
  });

  it('records per-account status for inactive and disconnected accounts and keeps syncing the rest', async () => {
    const { fetch } = routeFetch({
      'GET /v1/financial_connections/accounts/fca_1': fcAccount({ status: 'inactive' }),
      'GET /v1/financial_connections/accounts/fca_2': fcAccount({ id: 'fca_2', status: 'disconnected' }),
      'GET /v1/financial_connections/accounts/fca_3': fcAccount({ id: 'fca_3' }),
      'GET /v1/financial_connections/transactions': { data: [fcTxn({ id: 'fctxn_9', account: 'fca_3' })], has_more: false },
    });
    const result = await createStripeFcProvider({ ...config, fetch }).syncTransactions(
      stored({ accountIds: ['fca_1', 'fca_2', 'fca_3'] }),
      null,
    );
    expect(result.accountStatuses).toEqual({ fca_1: 'reauth_required', fca_2: 'disconnected', fca_3: 'active' });
    expect(result.upserts.map((t) => t.providerTransactionId)).toEqual(['fctxn_9']);
  });

  it('uses only the accounts the caller mapped', async () => {
    const { fetch, calls } = routeFetch({ 'GET /v1/financial_connections/accounts/fca_only': fcAccount({ id: 'fca_only', transaction_refresh: null }) });
    await createStripeFcProvider({ ...config, fetch }).syncTransactions(stored({ accountIds: ['fca_only'], metadata: { accountIds: ['fca_1', 'fca_only'] } }), null);
    expect(calls.map((c) => c.path)).toEqual(['/v1/financial_connections/accounts/fca_only']);
  });
});

describe('Stripe FC balances, refresh, disconnect', () => {
  it('reads balances from the account object', async () => {
    const { fetch } = routeFetch({ 'GET /v1/financial_connections/accounts/fca_1': fcAccount() });
    const [balance] = await createStripeFcProvider({ ...config, fetch }).getBalances(stored());
    expect(balance).toMatchObject({ accountId: 'fca_1', current: 160000, available: 150000, currency: 'USD' });
  });

  it('refreshes transactions and balance, ignoring rate limits', async () => {
    const { fetch, calls } = routeFetch({
      'POST /v1/financial_connections/accounts/fca_1/refresh': () =>
        jsonResponse(400, { error: { code: 'financial_connections_account_refresh_too_soon', message: 'too soon' } }),
    });
    await expect(createStripeFcProvider({ ...config, fetch }).refresh?.(stored())).resolves.toBeUndefined();
    expect(calls[0]?.payload).toMatchObject({ 'features[0]': 'transactions', 'features[1]': 'balance' });
  });

  it('disconnects every account', async () => {
    const { fetch, calls } = routeFetch({
      'POST /v1/financial_connections/accounts/fca_1/disconnect': {},
      'POST /v1/financial_connections/accounts/fca_2/disconnect': () => jsonResponse(400, { error: { message: 'already disconnected' } }),
    });
    await createStripeFcProvider({ ...config, fetch }).disconnect(stored({ accountIds: ['fca_1', 'fca_2'] }));
    expect(calls).toHaveLength(2);
  });
});

describe('Stripe FC webhooks', () => {
  const secret = 'whsec_fc';
  const now = 1_800_000_000_000;

  async function delivery(event: Record<string, unknown>, signed = true) {
    const body = JSON.stringify(event);
    const header = signed ? await buildStripeSignatureHeader(body, secret, now / 1000) : 't=1,v1=bad';
    return new Request('https://hooks.example/webhooks/bank-feeds/stripe-fc', { method: 'POST', body, headers: { 'Stripe-Signature': header } });
  }

  it('turns a successful transaction refresh into a sync, keyed by account', async () => {
    const provider = createStripeFcProvider(config);
    const request = await delivery({
      id: 'evt_1',
      type: 'financial_connections.account.refreshed_transactions',
      data: { object: { id: 'fca_1', transaction_refresh: { id: 'fctxnref_5', status: 'succeeded' } } },
    });
    expect(await provider.parseWebhook(request, { webhookSecret: secret, now })).toEqual([
      { type: 'sync_available', providerConnectionId: 'fca_1', accountIds: ['fca_1'] },
    ]);
  });

  it('rejects bad signatures and missing secrets', async () => {
    const provider = createStripeFcProvider(config);
    const bad = await delivery({ id: 'evt_1', type: 'financial_connections.account.disconnected', data: { object: { id: 'fca_1' } } }, false);
    await expect(provider.parseWebhook(bad, { webhookSecret: secret, now })).rejects.toBeInstanceOf(WebhookVerificationError);
    const unsecured = await delivery({ id: 'evt_1', type: 'x', data: { object: { id: 'fca_1' } } });
    await expect(provider.parseWebhook(unsecured, { now })).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('maps lifecycle events', () => {
    const event = (type: string, object: Record<string, unknown> = {}) => stripeFcEventsFromWebhook({ type, data: { object: { id: 'fca_1', ...object } } });
    expect(event('financial_connections.account.deactivated')[0]).toMatchObject({ type: 'reauth_required', providerConnectionId: 'fca_1' });
    expect(event('financial_connections.account.disconnected')[0]?.type).toBe('disconnected');
    expect(event('financial_connections.account.reactivated')[0]?.type).toBe('sync_available');
    expect(event('financial_connections.account.upcoming_deactivation')[0]?.type).toBe('expiring');
    expect(event('financial_connections.account.refreshed_transactions', { transaction_refresh: { status: 'failed' } })).toEqual([]);
    expect(event('financial_connections.account.created')).toEqual([]);
    expect(stripeFcEventsFromWebhook({ type: 'invoice.paid', data: { object: { id: 'in_1' } } })).toEqual([]);
  });
});
