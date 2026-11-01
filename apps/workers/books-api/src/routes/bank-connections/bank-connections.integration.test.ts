/**
 * /api/bank-connections (pglite tenant and master databases) against the
 * providers' real HTTP APIs, answered by a `fetch` stub: Plaid and Stripe
 * Financial Connections linked (accounts with suggested matches, the master
 * index row), mapped to an existing and a new bank account, synced (posted,
 * pending and replaced pending lines, a file-imported duplicate flagged,
 * changes and removals, a reconciled line the bank removed kept with a
 * warning, balances, a bank asking to sign in again and the recovery),
 * disconnected and deleted; Enable Banking's bank list; the providers on offer
 * per country; billing (off: `ENVIRONMENT` is not test or production); and the
 * refusals: permissions, the second factor, validation, unknown, foreign and
 * disconnected connections, providers that are unknown or not configured.
 *
 * Nothing is mocked but `getMasterDb` (through `conformanceMasterDb`) and
 * `fetch`, so the conformance suite runs these against the Rust backend too.
 * The stub answers by URL and body only (never by how often it was called):
 * each write runs on both backends.
 */

import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  const { conformanceMasterDb } = await import('@weldsuite/worker-kit/testing/conformance');
  return { ...actual, getMasterDb: () => conformanceMasterDb(state.master) };
});

import { bankConnectionsRoutes } from './index';

const KEY = `${'0'.repeat(63)}2`;
const ENTITY = 'ent_bf_us';
const OTHER = 'ent_bf_other';
const { privateKey: EB_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const ENV = {
  DATABASE_ENCRYPTION_KEY: KEY,
  // Not test or production: billing-worker is not asked (billing off).
  ENVIRONMENT: 'development',
  PLAID_CLIENT_ID: 'plaid-client',
  PLAID_SECRET: 'plaid-secret',
  STRIPE_FC_SECRET_KEY: 'sk_test_feeds',
  PONTO_CLIENT_ID: 'ponto-client',
  PONTO_CLIENT_SECRET: 'ponto-secret',
  ENABLE_BANKING_APP_ID: 'eb-app',
  ENABLE_BANKING_PRIVATE_KEY: EB_KEY,
};

/** The env without Ponto's keys: Ponto is not configured. */
const NO_PONTO = { ...ENV, PONTO_CLIENT_ID: undefined, PONTO_CLIENT_SECRET: undefined };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
let db: Database;

interface CallOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
  perms?: string[];
  entity?: string | null;
  fva?: readonly [number, number] | null;
  env?: Record<string, unknown>;
}

async function call(path: string, opts: CallOptions = {}) {
  const { request } = createTestApp('/api/bank-connections', bankConnectionsRoutes, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: (opts.env ?? ENV) as any,
    context: {
      permissions: permissions(...(opts.perms ?? ['*'])),
      tenantDb: db,
      masterDb: master,
      ...(opts.fva !== undefined ? { factorVerificationAge: opts.fva } : {}),
    },
  });
  const entity = opts.entity === undefined ? ENTITY : opts.entity;
  const res = await request(`/api/bank-connections${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(entity ? { 'X-Accounting-Entity-Id': entity } : {}) },
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = res.status === 204 ? '' : await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: { data?: any; error?: { code: string; message: string }; pagination?: { totalCount: number; hasMore: boolean } } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { status: res.status, ...json };
}

// ── The providers ──────────────────────────────────────────────────────────

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const seconds = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000);

/** What the Plaid sandbox answers `/transactions/sync` with ('login': the bank wants a new sign-in). */
let plaidMode: 'ok' | 'login' = 'ok';

const plaidAccounts = {
  item: { item_id: 'item_bf', institution_id: 'ins_bf', institution_name: 'First Platypus Bank' },
  accounts: [
    { account_id: 'plaid_chk', name: 'Plaid Checking', mask: '0000', type: 'depository', subtype: 'checking', balances: { current: 110.5, iso_currency_code: 'USD' } },
    { account_id: 'plaid_cc', name: 'Plaid Credit Card', mask: '3333', type: 'credit', subtype: 'credit card', balances: { current: 410, iso_currency_code: 'USD' } },
    { account_id: 'plaid_sav', name: 'Plaid Saving', mask: '1111', type: 'depository', subtype: 'savings', balances: { current: 200, iso_currency_code: 'USD' } },
  ],
};

function plaidTx(id: string, account: string, amount: number, date: string, name: string, extra: Record<string, unknown> = {}) {
  return { transaction_id: id, account_id: account, amount, date, name, iso_currency_code: 'USD', pending: false, ...extra };
}

function plaidPage(cursor: string | undefined) {
  switch (cursor) {
    case undefined:
      return {
        added: [
          plaidTx('tx_grocery', 'plaid_chk', 42.1, day(-3), 'Whole Foods Market', { merchant_name: 'Whole Foods', personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES', confidence_level: 'HIGH' } }),
          plaidTx('tx_payroll', 'plaid_chk', -2500, day(-2), 'ACME PAYROLL'),
          plaidTx('tx_pend_coffee', 'plaid_chk', 4.5, day(-1), 'Blue Bottle Coffee', { pending: true }),
          plaidTx('tx_pend_taxi', 'plaid_chk', 18, day(-1), 'Yellow Cab', { pending: true }),
          plaidTx('tx_pend_old', 'plaid_chk', 9, day(-20), 'Old hold', { pending: true }),
          plaidTx('tx_unmapped', 'plaid_sav', 1, day(-1), 'Interest'),
        ],
        modified: [],
        removed: [],
        next_cursor: 'cur-1',
        has_more: true,
      };
    case 'cur-1':
      return {
        added: [
          plaidTx('tx_coffee', 'plaid_chk', 4.5, day(-1), 'Blue Bottle Coffee', { pending_transaction_id: 'tx_pend_coffee', check_number: null }),
          plaidTx('tx_card_1', 'plaid_cc', 19.99, day(-2), 'Spotify'),
          plaidTx('tx_card_2', 'plaid_cc', 19.99, day(-2), 'Spotify'),
        ],
        modified: [],
        removed: [],
        next_cursor: 'cur-2',
        has_more: false,
      };
    case 'cur-2':
      return {
        added: [],
        modified: [plaidTx('tx_grocery', 'plaid_chk', 45.1, day(-3), 'Whole Foods Market')],
        removed: [{ transaction_id: 'tx_payroll' }, { transaction_id: 'tx_card_1' }],
        next_cursor: 'cur-3',
        has_more: false,
      };
    default:
      return { added: [], modified: [], removed: [], next_cursor: cursor, has_more: false };
  }
}

function plaid(path: string, body: Record<string, unknown>): Response {
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  switch (path) {
    case '/link/token/create':
      return json({ link_token: 'link-sandbox-bf', expiration: '2026-12-31T00:00:00Z', request_id: 'r1' });
    case '/item/public_token/exchange':
      return body.public_token === 'public-sandbox-bf'
        ? json({ access_token: 'access-sandbox-bf', item_id: 'item_bf' })
        : json({ error_code: 'INVALID_PUBLIC_TOKEN', error_message: 'public token is invalid' }, 400);
    case '/accounts/get':
      return json(plaidAccounts);
    case '/transactions/sync':
      if (plaidMode === 'login') {
        return json({ error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed' }, 400);
      }
      return json(plaidPage(body.cursor as string | undefined));
    case '/transactions/refresh':
    case '/item/remove':
      return json({ request_id: 'r2' });
    default:
      return json({ error_code: 'NOT_FOUND', error_message: path }, 404);
  }
}

const stripeAccount = {
  id: 'fca_bf',
  object: 'financial_connections.account',
  category: 'cash',
  subcategory: 'checking',
  display_name: 'Stripe Checking',
  institution_name: 'StripeBank',
  last4: '6789',
  status: 'active',
  permissions: ['transactions', 'balances'],
  subscriptions: [],
  balance: { current: { usd: 250_000 }, as_of: seconds(day(-1)) },
  transaction_refresh: { id: 'fctxnref_bf', status: 'succeeded' },
};

function stripe(method: string, url: URL): Response {
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const path = url.pathname;
  if (method === 'GET' && path === '/v1/customers/search') return json({ data: [] });
  if (method === 'POST' && path === '/v1/customers') return json({ id: 'cus_bf' });
  if (method === 'POST' && path === '/v1/financial_connections/sessions') {
    return json({ id: 'fcsess_bf', client_secret: 'fcsess_bf_secret' });
  }
  if (method === 'GET' && path === '/v1/financial_connections/sessions/fcsess_bf') {
    return json({ id: 'fcsess_bf', account_holder: { type: 'customer', customer: 'cus_bf' }, accounts: { data: [stripeAccount], has_more: false } });
  }
  if (method === 'POST' && path.startsWith('/v1/financial_connections/accounts/fca_bf/')) return json({ id: 'fca_bf' });
  if (method === 'GET' && path === '/v1/financial_connections/accounts/fca_bf') return json(stripeAccount);
  if (method === 'GET' && path === '/v1/financial_connections/transactions') {
    return json({
      data: [
        { id: 'fctxn_aws', account: 'fca_bf', amount: -1500, currency: 'usd', description: 'AWS', status: 'posted', transacted_at: seconds(day(-2)), status_transitions: { posted_at: seconds(day(-2)) } },
        { id: 'fctxn_lyft', account: 'fca_bf', amount: -800, currency: 'usd', description: 'Lyft', status: 'pending', transacted_at: seconds(day(-1)) },
        { id: 'fctxn_void', account: 'fca_bf', amount: -100, currency: 'usd', description: 'Voided', status: 'void', transacted_at: seconds(day(-1)) },
      ],
      has_more: false,
    });
  }
  return json({ error: { type: 'invalid_request_error', message: `No such route ${path}` } }, 404);
}

const PONTO_ACCOUNT = {
  id: 'pacc_bf',
  type: 'account',
  attributes: {
    reference: 'BE68 5390 0754 7034',
    referenceType: 'IBAN',
    description: 'Ponto Business',
    currency: 'EUR',
    subtype: 'checking',
    currentBalance: 1477.85,
    synchronizedAt: '2026-10-30T08:00:00.000Z',
    authorizationExpirationExpectedAt: `${day(120)}T00:00:00.000Z`,
  },
  relationships: { financialInstitution: { data: { id: 'fi_bf', type: 'financialInstitution' } } },
};

function ponto(method: string, url: URL, body: string): Response {
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const path = url.pathname.slice('/ponto-connect'.length);
  if (method === 'POST' && path === '/oauth2/token') {
    return new URLSearchParams(body).get('code') === 'ponto-code'
      ? json({ access_token: 'ponto-access', refresh_token: 'ponto-refresh', expires_in: 1800, token_type: 'bearer' })
      : json({ error: 'invalid_grant', error_description: 'the code is unknown' }, 400);
  }
  if (method === 'POST' && (path === '/oauth2/revoke' || path === '/synchronizations')) return json({});
  if (method === 'GET' && path === '/accounts') return json({ data: [PONTO_ACCOUNT], links: {} });
  if (method === 'GET' && path === '/accounts/pacc_bf') return json({ data: PONTO_ACCOUNT });
  if (method === 'GET' && path === '/accounts/pacc_bf/transactions') {
    return json({
      data: [
        { id: 'ptx_supplies', type: 'transaction', attributes: { amount: -42.5, currency: 'EUR', executionDate: `${day(-2)}T09:00:00.000Z`, remittanceInformation: 'Office supplies', counterpartName: 'Bureau BV' } },
        { id: 'ptx_invoice', type: 'transaction', attributes: { amount: 1000, currency: 'EUR', valueDate: `${day(-1)}T00:00:00.000Z`, description: 'Invoice 12', counterpartName: 'Client NV' } },
        { id: 'ptx_ancient', type: 'transaction', attributes: { amount: -1, currency: 'EUR', executionDate: '2020-01-01T00:00:00.000Z', remittanceInformation: 'Too old' } },
      ],
      links: {},
    });
  }
  return json({ errors: [{ code: 'resourceNotFound', detail: path }] }, 404);
}

function enableBanking(method: string, url: URL, body: string): Response {
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  if (method === 'GET' && url.pathname === '/aspsps') {
    return json({ aspsps: [{ name: 'Nordea', country: url.searchParams.get('country'), logo: 'https://enablebanking.com/nordea.png' }, { name: 'OP' }] });
  }
  if (method === 'POST' && url.pathname === '/sessions') {
    if ((JSON.parse(body) as { code?: string }).code !== 'eb-code') return json({ message: 'Wrong authorization code', error: 'WRONG_AUTHORIZATION_CODE' }, 400);
    return json({
      session_id: 'eb_sess_bf',
      aspsp: { name: 'Nordea', country: 'FI' },
      access: { valid_until: `${day(150)}T00:00:00Z` },
      accounts: [{ uid: 'eb_acc_bf', account_id: { iban: 'FI2112345600000785' }, name: 'Nordea Business', cash_account_type: 'CACC', currency: 'EUR' }],
    });
  }
  if (method === 'GET' && url.pathname === '/accounts/eb_acc_bf/transactions') {
    return json({
      transactions: [
        { entry_reference: 'eb_tx_beans', transaction_amount: { amount: '12.30', currency: 'EUR' }, credit_debit_indicator: 'DBIT', booking_date: day(-3), remittance_information: ['Coffee', 'beans'], creditor: { name: 'Roastery' } },
        { transaction_amount: { amount: '500.00', currency: 'EUR' }, credit_debit_indicator: 'CRDT', booking_date: day(-1), debtor: { name: 'Customer Oy' } },
      ],
      continuation_key: null,
    });
  }
  if (method === 'GET' && url.pathname === '/accounts/eb_acc_bf/balances') {
    return json({ balances: [{ balance_type: 'ITAV', balance_amount: { amount: '1.00', currency: 'EUR' } }, { balance_type: 'CLBD', balance_amount: { amount: '987.70', currency: 'EUR' }, credit_debit_indicator: 'CRDT', reference_date: day(-1) }] });
  }
  if (method === 'DELETE' && url.pathname === '/sessions/eb_sess_bf') return json({ message: 'Session deleted' });
  return json({ message: 'Not found', error: 'NOT_FOUND' }, 404);
}

const realFetch = globalThis.fetch;

/** The providers answer; every other call (the harness's own) goes to the real `fetch`. */
const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  const method = init?.method ?? 'GET';
  const text = typeof init?.body === 'string' ? init.body : '';
  if (url.hostname === 'sandbox.plaid.com') return plaid(url.pathname, text ? (JSON.parse(text) as Record<string, unknown>) : {});
  if (url.hostname === 'api.stripe.com') return stripe(method, url);
  if (url.hostname === 'api.ibanity.com') return ponto(method, url, text);
  if (url.hostname === 'api.enablebanking.com') return enableBanking(method, url, text);
  return realFetch(input, init);
});

let plaidId = '';
let stripeId = '';
let pontoId = '';
let ebId = '';

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  state.master = master;
  db = (await createPgliteDb()).db;
  vi.stubGlobal('fetch', providerFetch);
  await master.insert(masterSchema.workspaces).values({ id: 'ws_test_default', clerkOrgId: 'org_test_default', name: 'Feeds', slug: 'books-feeds' });
  await db.insert(schema.entities).values([
    { id: ENTITY, name: 'Feeds Inc', jurisdictionCode: 'US', baseCurrency: 'USD', locale: 'en-US' },
    { id: OTHER, name: 'Feeds BV', jurisdictionCode: 'FI', baseCurrency: 'EUR', locale: 'en-US' },
  ]);
  const now = new Date();
  await db.insert(schema.accounts).values([
    { id: 'acc_bf_bank', entityId: ENTITY, code: '1000', name: 'Operating', type: 'asset', subtype: 'bank', normalSide: 'debit', createdAt: now, updatedAt: now },
    { id: 'acc_bf_ccp', entityId: ENTITY, code: '2100', name: 'Credit Card Payable', type: 'liability', subtype: 'credit_card', normalSide: 'credit', metadata: { systemRole: 'credit_card_payable' }, createdAt: now, updatedAt: now },
    { id: 'acc_bf_other', entityId: OTHER, code: '1100', name: 'Bank', type: 'asset', subtype: 'bank', normalSide: 'debit', createdAt: now, updatedAt: now },
  ]);
  await db.insert(schema.bankAccounts).values([
    { id: 'ba_bf_main', entityId: ENTITY, name: 'Operating', currency: 'USD', ledgerAccountId: 'acc_bf_bank', accountNumberLast4: '0000', accountType: 'checking', isDefault: true, createdAt: now, updatedAt: now },
    { id: 'ba_bf_other', entityId: OTHER, name: 'Other entity', currency: 'EUR', ledgerAccountId: 'acc_bf_other', createdAt: now, updatedAt: now },
  ]);
  // The grocery line, imported from a statement file before the feed was connected.
  await db.insert(schema.bankTransactions).values({
    id: 'bt_bf_imported',
    entityId: ENTITY,
    bankAccountId: 'ba_bf_main',
    date: new Date(`${day(-3)}T00:00:00.000Z`),
    description: 'Whole Foods Market',
    amount: '-42.10',
    status: 'unreconciled',
    source: 'import',
    createdAt: now,
    updatedAt: now,
  });
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('what can be linked', () => {
  it('offers the configured providers for the asked country, else the entity\x27s', async () => {
    const us = await call('/providers?country=us');
    expect(us.status).toBe(200);
    expect(us.data.country).toBe('US');
    expect(us.data.providers.map((p: { id: string }) => p.id)).toEqual(['plaid', 'stripe_fc']);
    expect(us.data.providers[0]).toMatchObject({ kind: 'plaid_link', requiresInstitution: false });

    const entity = await call('/providers');
    expect(entity.data.country).toBe('US');

    const finland = await call('/providers', { entity: OTHER });
    expect(finland.data.country).toBe('FI');
    expect(finland.data.providers).toEqual([
      expect.objectContaining({ id: 'ponto', kind: 'redirect', requiresInstitution: false }),
      expect.objectContaining({ id: 'enable_banking', kind: 'redirect', requiresInstitution: true }),
    ]);
    const withoutPonto = await call('/providers', { entity: OTHER, env: NO_PONTO });
    expect(withoutPonto.data.providers.map((p: { id: string }) => p.id)).toEqual(['enable_banking']);

    expect((await call('/providers', { perms: ['banking:create'] })).status).toBe(403);
  });

  it('lists the banks of a provider that has a list', async () => {
    const banks = await call('/institutions?provider=enable_banking&country=fi');
    expect(banks.status).toBe(200);
    expect(banks.data).toEqual([
      { id: 'Nordea', name: 'Nordea', country: 'FI', logoUrl: 'https://enablebanking.com/nordea.png' },
      { id: 'OP', name: 'OP', country: 'FI', logoUrl: null },
    ]);
    expect(banks.pagination).toMatchObject({ totalCount: 2, hasMore: false });

    expect((await call('/institutions?provider=plaid')).status).toBe(400);
    const plaidList = await call('/institutions?provider=plaid&country=US');
    expect(plaidList.status).toBe(400);
    expect(plaidList.error?.message).toBe("Provider 'plaid' has no institution list");
    const ponto = await call('/institutions?provider=ponto&country=BE');
    expect(ponto.status).toBe(400);
    const unconfigured = await call('/institutions?provider=ponto&country=BE', { env: NO_PONTO });
    expect(unconfigured.status).toBe(503);
    expect((await call('/institutions?provider=nope&country=BE')).status).toBe(400);
  });

  it('has no billing here', async () => {
    const billing = await call('/billing');
    expect(billing.status).toBe(200);
    expect(billing.data).toBeNull();
  });

  it('lists no connections yet', async () => {
    const empty = await call('');
    expect(empty.status).toBe(200);
    expect(empty.data).toEqual([]);
  });
});

describe('starting a link', () => {
  const link = { provider: 'plaid', redirectUrl: 'https://app.weldsuite.test/books/banking' };

  it('takes a recently verified second factor', async () => {
    const stale = await call('/link-session', { method: 'POST', body: link, fva: [0, 30] });
    expect(stale.status).toBe(403);
    expect(stale.error?.code).toBe('REVERIFICATION_REQUIRED');
    const none = await call('/link-session', { method: 'POST', body: link, fva: [0, -1] });
    expect(none.status).toBe(403);
    expect(none.error?.code).toBe('MFA_REQUIRED');
    expect((await call('/link-session', { method: 'POST', body: link, perms: ['banking:read'] })).status).toBe(403);
  });

  it('validates the request', async () => {
    expect((await call('/link-session', { method: 'POST', body: {} })).status).toBe(400);
    expect((await call('/link-session', { method: 'POST', rawBody: '{nope' })).status).toBe(400);
    expect((await call('/link-session', { method: 'POST', body: { ...link, redirectUrl: 'not a url' } })).status).toBe(400);
    expect((await call('/link-session', { method: 'POST', body: { ...link, mode: 'sometimes', psuType: 'robot' } })).status).toBe(400);
    expect(
      (await call('/link-session', { method: 'POST', body: { ...link, institution: { name: '', country: 'FIN' }, acceptExtraCharge: 'yes' } })).status,
    ).toBe(400);
  });

  it('refuses unknown and unconfigured providers, and a relink without its connection', async () => {
    const unknown = await call('/link-session', { method: 'POST', body: { ...link, provider: 'nope' } });
    expect(unknown.status).toBe(400);
    expect(unknown.error?.message).toBe("Unknown bank feed provider 'nope'");
    const ponto = await call('/link-session', { method: 'POST', body: { ...link, provider: 'ponto' }, env: NO_PONTO });
    expect(ponto.status).toBe(503);
    const noBank = await call('/link-session', { method: 'POST', body: { ...link, provider: 'enable_banking' } });
    expect(noBank.status).toBe(400);
    expect(noBank.error?.message).toBe('Enable Banking needs the bank chosen up front');
    const relink = await call('/link-session', { method: 'POST', body: { ...link, mode: 'reauth' } });
    expect(relink.status).toBe(400);
    const missing = await call('/link-session', { method: 'POST', body: { ...link, mode: 'reauth', connectionId: 'bkc_nope' } });
    expect(missing.status).toBe(404);
    expect(missing.error?.code).toBe('NOT_FOUND');
  });

  it('starts Plaid Link and a Stripe Financial Connections session', async () => {
    const plaidSession = await call('/link-session', { method: 'POST', body: link });
    expect(plaidSession.status).toBe(201);
    expect(plaidSession.data).toEqual({
      kind: 'plaid_link',
      token: 'link-sandbox-bf',
      expiresAt: '2026-12-31T00:00:00Z',
      provider: 'plaid',
      historyDays: 730,
    });

    const stripeSession = await call('/link-session', {
      method: 'POST',
      body: { provider: 'stripe_fc', redirectUrl: 'https://app.weldsuite.test/return?x=1', institution: { name: 'StripeBank', country: 'US' } },
    });
    expect(stripeSession.status).toBe(201);
    expect(stripeSession.data).toEqual({
      kind: 'stripe_fc',
      clientSecret: 'fcsess_bf_secret',
      sessionId: 'fcsess_bf',
      provider: 'stripe_fc',
      historyDays: 180,
    });
  });
});

describe('Plaid', () => {
  it('refuses a public token Plaid does not know', async () => {
    const bad = await call('/complete', { method: 'POST', body: { provider: 'plaid', payload: { publicToken: 'public-sandbox-nope' } } });
    expect(bad.status).toBe(400);
    expect(bad.error?.message).toBe('plaid responded 400');
    expect((await call('/complete', { method: 'POST', body: { provider: 'plaid', payload: 'token' } })).status).toBe(400);
    expect((await call('/complete', { method: 'POST', body: { provider: 'plaid', payload: {} }, entity: 'ent_nope' })).status).toBe(400);
  });

  it('completes a link: the accounts with a suggested match, the master index row', async () => {
    const linked = await call('/complete', { method: 'POST', body: { provider: 'plaid', payload: { publicToken: 'public-sandbox-bf' } } });
    expect(linked.status).toBe(201);
    plaidId = linked.data.connection.id;
    expect(linked.data.connection).toMatchObject({
      entityId: ENTITY,
      provider: 'plaid',
      institutionId: 'ins_bf',
      institutionName: 'First Platypus Bank',
      status: 'active',
      lastSyncedAt: null,
      historyDays: 730,
      warnings: [],
    });
    expect(linked.data.accounts).toEqual([
      expect.objectContaining({ feedAccountId: 'plaid_chk', mask: '0000', type: 'depository', subtype: 'checking', currency: 'USD', bankAccountId: null, suggestion: { bankAccountId: 'ba_bf_main', bankAccountName: 'Operating', reason: 'last4' } }),
      expect.objectContaining({ feedAccountId: 'plaid_cc', type: 'credit', subtype: 'credit_card', suggestion: null }),
      expect.objectContaining({ feedAccountId: 'plaid_sav', subtype: 'savings', suggestion: null }),
    ]);
    expect(JSON.stringify(linked.data)).not.toContain('access-sandbox-bf');

    const [row] = await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, plaidId));
    expect(row?.credentialsEncrypted).toBeTruthy();
    expect(row?.credentialsEncrypted).not.toContain('access-sandbox-bf');
    const index = await master.select().from(masterSchema.bankFeedConnectionIndex).where(eq(masterSchema.bankFeedConnectionIndex.connectionId, plaidId));
    expect(index).toEqual([expect.objectContaining({ provider: 'plaid', providerConnectionId: 'item_bf', clerkOrgId: 'org_test_default', entityId: ENTITY, isActive: true, syncIntervalHours: 24 })]);
  });

  it('links the same bank login again into the same connection', async () => {
    const again = await call('/complete', { method: 'POST', body: { provider: 'plaid', payload: { publicToken: 'public-sandbox-bf' } } });
    expect(again.status).toBe(200);
    expect(again.data.connection.id).toBe(plaidId);
    const elsewhere = await call('/complete', { method: 'POST', body: { provider: 'plaid', payload: { publicToken: 'public-sandbox-bf' } }, entity: OTHER });
    expect(elsewhere.status).toBe(409);
    const foreign = await call('/complete', { method: 'POST', body: { provider: 'plaid', payload: {}, connectionId: plaidId }, entity: OTHER });
    expect(foreign.status).toBe(404);
    const wrongProvider = await call('/complete', { method: 'POST', body: { provider: 'stripe_fc', payload: {}, connectionId: plaidId } });
    expect(wrongProvider.status).toBe(400);
  });

  it('reads one connection and the list, never another entity\x27s', async () => {
    const one = await call(`/${plaidId}`);
    expect(one.status).toBe(200);
    expect(one.data.accounts[0]).not.toHaveProperty('suggestion');
    const list = await call('');
    expect(list.data.map((c: { id: string }) => c.id)).toEqual([plaidId]);
    expect((await call(`/${plaidId}`, { entity: OTHER })).status).toBe(404);
    expect((await call('', { entity: OTHER })).data).toEqual([]);
    const missing = await call('/bkc_nope');
    expect(missing.status).toBe(404);
    expect(missing.error).toEqual({ code: 'NOT_FOUND', message: "Bank connection 'bkc_nope' not found" });
  });

  it('validates and refuses mappings', async () => {
    const path = `/${plaidId}/map-accounts`;
    expect((await call(path, { method: 'POST', body: { mappings: [] } })).status).toBe(400);
    expect((await call(path, { method: 'POST', body: { mappings: [{ feedAccountId: 'plaid_chk', syncFrom: '2026/01/01' }], syncFrom: 'soon', sync: 'no' } })).status).toBe(400);
    expect((await call(path, { method: 'POST', body: { mappings: [{ feedAccountId: '', create: { name: '', accountType: 'piggy_bank' } }] } })).status).toBe(400);
    const unknownFeed = await call(path, { method: 'POST', body: { mappings: [{ feedAccountId: 'plaid_nope', bankAccountId: 'ba_bf_main' }] } });
    expect(unknownFeed.status).toBe(400);
    expect(unknownFeed.error?.message).toBe("Feed account 'plaid_nope' is not on this connection");
    const neither = await call(path, { method: 'POST', body: { mappings: [{ feedAccountId: 'plaid_chk' }] } });
    expect(neither.error?.message).toBe('Each mapping needs bankAccountId or create');
    const twice = await call(path, {
      method: 'POST',
      body: { mappings: [{ feedAccountId: 'plaid_chk', bankAccountId: 'ba_bf_main' }, { feedAccountId: 'plaid_chk', bankAccountId: 'ba_bf_main' }] },
    });
    expect(twice.error?.message).toBe("Feed account 'plaid_chk' is mapped twice");
    const foreignBank = await call(path, { method: 'POST', body: { mappings: [{ feedAccountId: 'plaid_chk', bankAccountId: 'ba_bf_other' }] } });
    expect(foreignBank.status).toBe(404);
    const noLedger = await call(path, { method: 'POST', body: { mappings: [{ feedAccountId: 'plaid_cc', create: { name: 'Card', ledgerAccountId: 'acc_bf_other' } }] } });
    expect(noLedger.status).toBe(400);
    expect(noLedger.error?.message).toBe("Ledger account 'acc_bf_other' not found on this entity");
    expect((await call('/bkc_nope/map-accounts', { method: 'POST', body: { mappings: [{ feedAccountId: 'x', bankAccountId: 'y' }] } })).status).toBe(404);
    expect((await call(path, { method: 'POST', body: { mappings: [{ feedAccountId: 'plaid_chk', bankAccountId: 'ba_bf_main' }] }, perms: ['banking:read'] })).status).toBe(403);
  });

  it('maps a feed account to an existing bank account and one to a new card account', async () => {
    const mapped = await call(`/${plaidId}/map-accounts`, {
      method: 'POST',
      body: {
        mappings: [
          { feedAccountId: 'plaid_chk', bankAccountId: 'ba_bf_main' },
          { feedAccountId: 'plaid_cc', create: { name: 'Platypus Card' }, syncFrom: null },
        ],
        syncFrom: day(-30),
        sync: false,
      },
    });
    expect(mapped.status).toBe(200);
    expect(mapped.data.syncStarted).toBe(false);
    expect(mapped.data.mapped).toEqual([
      { feedAccountId: 'plaid_chk', bankAccountId: 'ba_bf_main', created: false },
      { feedAccountId: 'plaid_cc', bankAccountId: expect.any(String), created: true },
    ]);
    expect(mapped.data.connection.accounts).toEqual([
      expect.objectContaining({ feedAccountId: 'plaid_chk', bankAccountId: 'ba_bf_main', bankAccountName: 'Operating', syncFrom: day(-30) }),
      expect.objectContaining({ feedAccountId: 'plaid_cc', bankAccountName: 'Platypus Card', syncFrom: day(-30) }),
      expect.objectContaining({ feedAccountId: 'plaid_sav', bankAccountId: null }),
    ]);
    const [card] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.name, 'Platypus Card'));
    expect(card).toMatchObject({ accountType: 'credit_card', accountNumberLast4: '3333', bankName: 'First Platypus Bank', feedProvider: 'plaid', isDefault: false });
    const [ledger] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, card?.ledgerAccountId ?? ''));
    expect(ledger).toMatchObject({ type: 'liability', subtype: 'credit_card', code: '2101', parentAccountId: 'acc_bf_ccp' });

  });

  it('syncs: posted, pending and replaced pending lines, the imported duplicate flagged, balances', async () => {
    expect((await call(`/${plaidId}/sync`, { method: 'POST', perms: ['banking:read'] })).status).toBe(403);
    expect((await call(`/${plaidId}/sync`, { method: 'POST', entity: OTHER })).status).toBe(404);

    const synced = await call(`/${plaidId}/sync`, { method: 'POST', body: {} });
    expect(synced.status).toBe(200);
    expect(synced.data.outcome).toEqual({
      connectionId: plaidId,
      status: 'active',
      added: 5,
      updated: 0,
      removed: 0,
      pending: 3,
      pendingVoided: 1,
      possibleDuplicates: 1,
      autoReconciled: 0,
      warnings: 0,
    });
    expect(synced.data.connection.lastSyncedAt).toEqual(expect.any(String));

    const lines = await db
      .select()
      .from(schema.bankTransactions)
      .where(and(eq(schema.bankTransactions.feedProvider, 'plaid'), eq(schema.bankTransactions.providerTransactionId, 'tx_grocery')));
    expect(lines).toEqual([
      expect.objectContaining({ amount: '-42.10', source: 'feed', status: 'unreconciled', possibleDuplicateOfId: 'bt_bf_imported', merchantName: 'Whole Foods' }),
    ]);
    const [main] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, 'ba_bf_main'));
    expect(main?.currentBalance).toBe('110.50');

    const pending = await call(`/${plaidId}/pending`);
    expect(pending.status).toBe(200);
    expect(pending.data).toEqual([expect.objectContaining({ bankAccountId: 'ba_bf_main', amount: '-18.00', description: 'Yellow Cab' })]);
    expect((await call(`/${plaidId}/pending?bankAccountId=ba_bf_other`)).data).toEqual([]);
    expect((await call('/bkc_nope/pending')).status).toBe(404);
  });

  it('follows changes and removals; a removed line already reconciled stays, with a warning', async () => {
    await db
      .update(schema.bankTransactions)
      .set({ status: 'reconciled' })
      .where(eq(schema.bankTransactions.providerTransactionId, 'tx_card_1'));
    const synced = await call(`/${plaidId}/sync`, { method: 'POST' });
    expect(synced.data.outcome).toMatchObject({ added: 0, updated: 1, removed: 1, warnings: 1 });
    expect(synced.data.connection.warnings).toEqual([
      expect.objectContaining({ code: 'removed_reconciled', providerTransactionId: 'tx_card_1' }),
    ]);
    const [payroll] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.providerTransactionId, 'tx_payroll'));
    expect(payroll?.deletedAt).not.toBeNull();
  });

  it('records a bank that asks to sign in again, and recovers on the next clean read', async () => {
    plaidMode = 'login';
    try {
      const failed = await call(`/${plaidId}/sync`, { method: 'POST' });
      expect(failed.status).toBe(200);
      expect(failed.data.outcome).toMatchObject({
        status: 'reauth_required',
        error: 'Plaid ITEM_LOGIN_REQUIRED: the login details of this item have changed',
        retryable: false,
      });
      expect(failed.data.connection.status).toBe('reauth_required');
    } finally {
      plaidMode = 'ok';
    }
    const [index] = await master.select().from(masterSchema.bankFeedConnectionIndex).where(eq(masterSchema.bankFeedConnectionIndex.connectionId, plaidId));
    expect(index?.isActive).toBe(false);

    const relink = await call('/link-session', {
      method: 'POST',
      body: { provider: 'plaid', mode: 'add_accounts', connectionId: plaidId, redirectUrl: 'https://app.weldsuite.test/books/banking' },
    });
    expect(relink.status).toBe(201);

    const recovered = await call(`/${plaidId}/sync`, { method: 'POST', body: { refresh: true } });
    expect(recovered.data.outcome).toMatchObject({ status: 'active', added: 0 });
    expect(recovered.data.connection.status).toBe('active');
  });

  it('disconnects: revoked at Plaid, every synced line kept, no relinking it', async () => {
    expect((await call(`/${plaidId}/disconnect`, { method: 'POST', perms: ['banking:update'] })).status).toBe(403);
    const disconnected = await call(`/${plaidId}/disconnect`, { method: 'POST' });
    expect(disconnected.status).toBe(200);
    expect(disconnected.data.status).toBe('disconnected');
    expect(disconnected.data.accounts.every((a: { status: string }) => a.status === 'disconnected')).toBe(true);
    const kept = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.feedProvider, 'plaid'));
    expect(kept.length).toBeGreaterThan(0);
    const index = await master.select().from(masterSchema.bankFeedConnectionIndex).where(eq(masterSchema.bankFeedConnectionIndex.connectionId, plaidId));
    expect(index).toEqual([]);

    const relink = await call('/link-session', {
      method: 'POST',
      body: { provider: 'plaid', mode: 'reauth', connectionId: plaidId, redirectUrl: 'https://app.weldsuite.test/books/banking' },
    });
    expect(relink.status).toBe(409);
    const skipped = await call(`/${plaidId}/sync`, { method: 'POST' });
    expect(skipped.data.outcome).toMatchObject({ skipped: 'not_active', status: 'disconnected' });
  });
});

describe('Stripe Financial Connections', () => {
  it('completes a session: the accounts subscribed to transactions', async () => {
    const missing = await call('/complete', { method: 'POST', body: { provider: 'stripe_fc', payload: {} } });
    expect(missing.status).toBe(400);
    expect(missing.error?.message).toBe('Stripe Financial Connections session id missing');

    const linked = await call('/complete', { method: 'POST', body: { provider: 'stripe_fc', payload: { sessionId: 'fcsess_bf' } } });
    expect(linked.status).toBe(201);
    stripeId = linked.data.connection.id;
    expect(linked.data.connection).toMatchObject({ provider: 'stripe_fc', institutionId: 'stripebank', institutionName: 'StripeBank', historyDays: 180 });
    expect(linked.data.accounts).toEqual([expect.objectContaining({ feedAccountId: 'fca_bf', mask: '6789', type: 'depository', subtype: 'checking', suggestion: null })]);
  });

  it('maps to a new bank account and syncs posted, pending and voided lines', async () => {
    const mapped = await call(`/${stripeId}/map-accounts`, {
      method: 'POST',
      body: { mappings: [{ feedAccountId: 'fca_bf', create: { name: 'Stripe Checking', accountType: 'checking' } }], sync: false },
    });
    expect(mapped.status).toBe(200);
    const synced = await call(`/${stripeId}/sync`, { method: 'POST' });
    expect(synced.data.outcome).toMatchObject({ status: 'active', added: 1, pending: 1, removed: 0 });
    const [account] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.name, 'Stripe Checking'));
    expect(account).toMatchObject({ currentBalance: '2500.00', ledgerAccountId: expect.any(String) });
    const [ledger] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account?.ledgerAccountId ?? ''));
    expect(ledger).toMatchObject({ type: 'asset', subtype: 'bank', code: '1001' });
  });

  it('deletes the connection: revoked at Stripe, the bank account unlinked', async () => {
    expect((await call(`/${stripeId}`, { method: 'DELETE', perms: ['banking:update'] })).status).toBe(403);
    expect((await call(`/${stripeId}`, { method: 'DELETE', entity: OTHER })).status).toBe(404);
    const removed = await call(`/${stripeId}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect((await call(`/${stripeId}`)).status).toBe(404);
    const [account] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.name, 'Stripe Checking'));
    expect(account).toMatchObject({ feedConnectionId: null, feedAccountId: null, feedStatus: null });
    expect((await call('')).data.map((c: { id: string }) => c.id)).toEqual([plaidId]);
  });
});

describe('Ponto', () => {
  const redirectUrl = 'https://app.weldsuite.test/books/banking/ponto';

  it('refuses an incomplete or unknown authorization', async () => {
    const incomplete = await call('/complete', { method: 'POST', body: { provider: 'ponto', payload: { code: 'ponto-code' } }, entity: OTHER });
    expect(incomplete.status).toBe(400);
    expect(incomplete.error?.message).toBe('Ponto authorization response incomplete');
    const unknown = await call('/complete', {
      method: 'POST',
      body: { provider: 'ponto', payload: { code: 'ponto-nope', state: 'state-bf', redirectUrl } },
      entity: OTHER,
    });
    expect(unknown.status).toBe(400);
    expect(unknown.error?.message).toBe('Ponto invalid_grant: the code is unknown');
  });

  it('completes a link: the account with its IBAN, the consent end', async () => {
    const linked = await call('/complete', {
      method: 'POST',
      body: { provider: 'ponto', payload: { code: 'ponto-code', state: 'state-bf', redirectUrl } },
      entity: OTHER,
    });
    expect(linked.status).toBe(201);
    pontoId = linked.data.connection.id;
    expect(linked.data.connection).toMatchObject({
      entityId: OTHER,
      provider: 'ponto',
      institutionName: 'Ponto',
      status: 'active',
      historyDays: 540,
      consentExpiresAt: `${day(120)}T00:00:00.000Z`,
    });
    expect(linked.data.accounts).toEqual([
      expect.objectContaining({ feedAccountId: 'pacc_bf', name: 'Ponto Business', mask: '7034', currency: 'EUR', subtype: 'checking', suggestion: null }),
    ]);
  });

  it('maps, refreshes and syncs inside the history window, then disconnects', async () => {
    const mapped = await call(`/${pontoId}/map-accounts`, {
      method: 'POST',
      body: { mappings: [{ feedAccountId: 'pacc_bf', create: { name: 'Ponto Business' } }], sync: false },
      entity: OTHER,
    });
    expect(mapped.status).toBe(200);
    const [account] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.name, 'Ponto Business'));
    expect(account).toMatchObject({ iban: 'BE68539007547034', accountNumberLast4: '7034', currency: 'EUR', bankName: 'Ponto' });

    const synced = await call(`/${pontoId}/sync`, { method: 'POST', body: { refresh: true }, entity: OTHER });
    expect(synced.status).toBe(200);
    expect(synced.data.outcome).toMatchObject({ status: 'active', added: 2, pending: 0, possibleDuplicates: 0 });
    const lines = await db
      .select()
      .from(schema.bankTransactions)
      .where(eq(schema.bankTransactions.feedProvider, 'ponto'));
    expect(lines.map((l) => [l.providerTransactionId, l.amount]).sort()).toEqual([
      ['ptx_invoice', '1000.00'],
      ['ptx_supplies', '-42.50'],
    ]);
    const [after] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.name, 'Ponto Business'));
    expect(after?.currentBalance).toBe('1477.85');

    const disconnected = await call(`/${pontoId}/disconnect`, { method: 'POST', entity: OTHER });
    expect(disconnected.status).toBe(200);
    expect(disconnected.data.status).toBe('disconnected');
  });
});

describe('Enable Banking', () => {
  it('refuses a missing or unknown authorization code', async () => {
    const missing = await call('/complete', { method: 'POST', body: { provider: 'enable_banking', payload: {} }, entity: OTHER });
    expect(missing.status).toBe(400);
    expect(missing.error?.message).toBe('Enable Banking authorization code missing');
    const unknown = await call('/complete', { method: 'POST', body: { provider: 'enable_banking', payload: { code: 'eb-nope' } }, entity: OTHER });
    expect(unknown.status).toBe(400);
  });

  it('completes, maps to an existing bank account and syncs booked lines and the closing balance', async () => {
    const linked = await call('/complete', { method: 'POST', body: { provider: 'enable_banking', payload: { code: 'eb-code' } }, entity: OTHER });
    expect(linked.status).toBe(201);
    ebId = linked.data.connection.id;
    expect(linked.data.connection).toMatchObject({
      provider: 'enable_banking',
      institutionId: 'Nordea',
      institutionName: 'Nordea',
      consentExpiresAt: `${day(150)}T00:00:00.000Z`,
      historyDays: 730,
    });
    expect(linked.data.accounts).toEqual([
      expect.objectContaining({ feedAccountId: 'eb_acc_bf', name: 'Nordea Business', mask: '0785', subtype: 'checking', suggestion: null }),
    ]);

    const mapped = await call(`/${ebId}/map-accounts`, {
      method: 'POST',
      body: { mappings: [{ feedAccountId: 'eb_acc_bf', bankAccountId: 'ba_bf_other' }], sync: false },
      entity: OTHER,
    });
    expect(mapped.status).toBe(200);
    const synced = await call(`/${ebId}/sync`, { method: 'POST', entity: OTHER });
    expect(synced.data.outcome).toMatchObject({ status: 'active', added: 2, pending: 0 });
    const lines = await db
      .select()
      .from(schema.bankTransactions)
      .where(eq(schema.bankTransactions.bankAccountId, 'ba_bf_other'));
    expect(lines.map((l) => [l.description, l.amount]).sort()).toEqual([
      ['Coffee beans', '-12.30'],
      ['Customer Oy', '500.00'],
    ]);
    const [other] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, 'ba_bf_other'));
    expect(other).toMatchObject({ currentBalance: '987.70', iban: 'FI2112345600000785', feedProvider: 'enable_banking' });
  });

  it('deletes the connection: the session ended at the bank', async () => {
    expect((await call(`/${ebId}`, { method: 'DELETE', entity: OTHER })).status).toBe(204);
    expect((await call('', { entity: OTHER })).data.map((c: { id: string }) => c.id)).toEqual([pontoId]);
  });
});
