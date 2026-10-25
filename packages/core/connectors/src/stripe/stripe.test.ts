import { describe, it, expect } from 'vitest';
import { getConnectorSync } from '../catalog';
import { getDefaultConnectorFieldMappings } from '../field-mappings';
import { createConnectorProviderClient } from '../factory';
import {
  hmacSha256Hex,
  matchWebhookTopic,
  readWebhookSignatureFromHeaders,
  readWebhookTopicFromPayload,
  unwrapWebhookPayload,
  verifyStripeWebhook,
} from '../webhooks';
import {
  buildStripeAuthorizeUrl,
  deauthorizeStripeAccount,
  exchangeStripeCode,
  isStripeOAuthState,
  newStripeOAuthState,
} from './auth';
import { StripeClient, stripeAmountToDecimal, stripeMinorUnits, STRIPE_API_VERSION } from './client';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function recorder(handler: (url: URL) => Response): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return handler(new URL(String(input)));
  };
  return { calls, fetchImpl };
}

function header(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init?.headers).get(name);
}

const invoicesSync = getConnectorSync('stripe', 'stripe-invoices')!.sync;
const linesSync = getConnectorSync('stripe', 'stripe-balance-transactions')!.sync;

describe('Stripe amounts', () => {
  it('converts minor units per currency', () => {
    expect(stripeMinorUnits('eur')).toBe(2);
    expect(stripeMinorUnits('JPY')).toBe(0);
    expect(stripeMinorUnits('kwd')).toBe(3);
    expect(stripeAmountToDecimal(12100, 'eur')).toBe('121.00');
    expect(stripeAmountToDecimal(500, 'jpy')).toBe('500.00');
    expect(stripeAmountToDecimal(-35, 'usd')).toBe('-0.35');
    expect(stripeAmountToDecimal('1999.5', 'eur', 4)).toBe('19.9950');
  });
});

describe('StripeClient auth', () => {
  it('uses the pasted key as-is, without Stripe-Account', async () => {
    const { calls, fetchImpl } = recorder(() => json({ id: 'acct_1', settings: { dashboard: { display_name: 'Acme' } } }));
    const client = new StripeClient({ apiKey: 'rk_live_abc' }, { fetchImpl });
    const tested = await client.test();
    expect(tested).toEqual({ ok: true, storeUrl: 'acct_1', accountName: 'Acme' });
    expect(header(calls[0], 'authorization')).toBe('Bearer rk_live_abc');
    expect(header(calls[0], 'stripe-account')).toBeNull();
    expect(header(calls[0], 'stripe-version')).toBe(STRIPE_API_VERSION);
    expect(client.mode).toBe('api_key');
  });

  it('reads an OAuth account with the platform key and Stripe-Account', async () => {
    const { calls, fetchImpl } = recorder(() => json({ id: 'acct_9' }));
    const client = new StripeClient(
      { accountId: 'acct_9', platformSecretKey: 'sk_platform', accessToken: 'sk_deprecated' },
      { fetchImpl },
    );
    await client.test();
    expect(header(calls[0], 'authorization')).toBe('Bearer sk_platform');
    expect(header(calls[0], 'stripe-account')).toBe('acct_9');
  });

  it('falls back to a balance read when a restricted key may not read the account', async () => {
    const { fetchImpl } = recorder((url) =>
      url.pathname.endsWith('/account')
        ? json({ error: { message: 'missing permission' } }, 403)
        : json({ available: [], pending: [] }),
    );
    const tested = await new StripeClient({ apiKey: 'rk_test_1234wxyz' }, { fetchImpl }).test();
    expect(tested).toEqual({ ok: true, storeUrl: 'key_wxyz' });
  });

  it('is built by the connector factory from stored credentials', () => {
    const client = createConnectorProviderClient('stripe', { stripeUserId: 'acct_2', platformSecretKey: 'sk' });
    expect(client).toBeInstanceOf(StripeClient);
    expect(client.storeUrl).toBe('acct_2');
  });
});

describe('StripeClient sync', () => {
  it('lists invoices from the import start date and fetches truncated lines', async () => {
    const { calls, fetchImpl } = recorder((url) => {
      if (url.pathname === '/v1/invoices') {
        return json({
          data: [
            { id: 'in_1', created: 1767225600, lines: { data: [{ id: 'il_1' }], has_more: true } },
            { id: 'in_old', created: 1700000000, lines: { data: [], has_more: false } },
          ],
          has_more: true,
        });
      }
      return json({ data: [{ id: 'il_1' }, { id: 'il_2' }], has_more: false });
    });
    const client = new StripeClient({ apiKey: 'rk', importStartDate: '2026-01-01' }, { fetchImpl });
    const page = await client.listSync(invoicesSync, { page: 1, cursor: null, limit: 100 });

    const listUrl = new URL(calls[0]!.url);
    expect(listUrl.searchParams.get('created[gte]')).toBe(String(Date.parse('2026-01-01T00:00:00Z') / 1000));
    expect(listUrl.searchParams.getAll('expand[]')).toContain('data.total_tax_amounts.tax_rate');
    expect(page.nextCursor).toBe('in_old');
    expect(page.done).toBe(false);
    const first = page.items[0] as { lines: { data: unknown[] }; updated_at: string; _weld_skip: boolean };
    expect(first.lines.data).toHaveLength(2);
    expect(first.updated_at).toBe(new Date(1767225600 * 1000).toISOString());
    expect(first._weld_skip).toBe(false);
    // Out-of-range invoices still travel so an all-old page never ends the scan.
    expect((page.items[1] as { _weld_skip: boolean })._weld_skip).toBe(true);
  });

  it('re-reads only the newest event per invoice on incremental runs', async () => {
    const { calls, fetchImpl } = recorder((url) => {
      if (url.pathname === '/v1/events') {
        return json({
          data: [
            { id: 'evt_2', created: 1767312000, data: { object: { id: 'in_1' } } },
            { id: 'evt_1', created: 1767225600, data: { object: { id: 'in_1' } } },
          ],
          has_more: false,
        });
      }
      return json({ id: 'in_1', created: 1767225600, lines: { data: [], has_more: false } });
    });
    const client = new StripeClient({ apiKey: 'rk' }, { fetchImpl });
    const page = await client.listSync(invoicesSync, {
      page: 1,
      cursor: null,
      limit: 100,
      modifiedAfter: '2026-01-01T00:00:00.000Z',
    });
    expect(page.items).toHaveLength(1);
    expect((page.items[0] as { updated_at: string }).updated_at).toBe(new Date(1767312000 * 1000).toISOString());
    expect(calls.filter((call) => call.url.includes('/v1/invoices/in_1'))).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.getAll('types[]')).toContain('invoice.paid');
  });

  it('splits each payout into gross, fee and payout lines', async () => {
    const { fetchImpl } = recorder((url) => {
      if (url.pathname === '/v1/payouts') {
        return json({
          data: [{ id: 'po_1', amount: 9500, currency: 'eur', created: 1767225600, arrival_date: 1767398400, automatic: true, balance_transaction: 'txn_po' }],
          has_more: false,
        });
      }
      return json({
        data: [
          {
            id: 'txn_ch',
            type: 'charge',
            amount: 10000,
            fee: 500,
            currency: 'eur',
            created: 1767139200,
            source: { id: 'ch_1', object: 'charge', invoice: 'in_1', billing_details: { name: 'Acme BV' } },
          },
          { id: 'txn_po', type: 'payout', amount: -9500, fee: 0, currency: 'eur', created: 1767225600, source: 'po_1' },
        ],
        has_more: false,
      });
    });
    const client = new StripeClient({ apiKey: 'rk' }, { fetchImpl });
    const page = await client.listSync(linesSync, { page: 1, cursor: null, limit: 100 });
    const lines = page.items as Array<Record<string, unknown>>;
    expect(lines.map((line) => [line.id, line.line, line.amount])).toEqual([
      ['txn_ch', 'gross', 10000],
      ['txn_ch_fee', 'fee', -500],
      ['txn_po', 'payout', -9500],
    ]);
    expect(lines[0]).toMatchObject({ invoice_id: 'in_1', charge_id: 'ch_1', customer_name: 'Acme BV', payout_id: 'po_1', balance_account: 'balance_EUR' });
  });

  it('registers a webhook endpoint only for API-key connections', async () => {
    const { calls, fetchImpl } = recorder(() => json({ id: 'we_1', secret: 'whsec_1', url: 'https://hooks/x' }));
    const topics = [
      { provider: 'stripe', topic: 'invoice.paid', settingKey: 'invoices' as const, kind: 'update' as const },
      { provider: 'stripe', topic: 'payout.paid', settingKey: 'bankTransactions' as const, kind: 'update' as const },
    ];
    const keyClient = new StripeClient({ apiKey: 'rk' }, { fetchImpl });
    const created = await keyClient.registerWebhooks({ deliveryUrl: 'https://hooks/x', secret: 'ignored', topics });
    expect(created).toEqual([{ id: 'we_1', topic: 'invoice.paid,payout.paid', deliveryUrl: 'https://hooks/x', secret: 'whsec_1' }]);
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(body.getAll('enabled_events[]')).toEqual(['invoice.paid', 'payout.paid']);
    expect(body.get('api_version')).toBe(STRIPE_API_VERSION);

    const oauthClient = new StripeClient({ accountId: 'acct_1', platformSecretKey: 'sk' }, { fetchImpl });
    expect(await oauthClient.registerWebhooks({ deliveryUrl: 'https://hooks/x', secret: 's', topics })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('only downloads invoice PDFs from Stripe hosts', async () => {
    const { calls, fetchImpl } = recorder(() => new Response('pdf', { headers: { 'content-type': 'application/pdf' } }));
    const client = new StripeClient({ apiKey: 'rk' }, { fetchImpl });
    expect(await client.downloadInvoicePdf('https://evil.example.com/x.pdf')).toBeNull();
    const pdf = await client.downloadInvoicePdf('https://pay.stripe.com/invoice/acct_1/x/pdf');
    expect(pdf?.contentType).toBe('application/pdf');
    expect(calls).toHaveLength(1);
  });
});

describe('Stripe OAuth helpers', () => {
  it('builds the authorize URL with the read_write scope and a prefixed state', () => {
    const state = newStripeOAuthState();
    expect(isStripeOAuthState(state)).toBe(true);
    expect(isStripeOAuthState('3f1c-uuid')).toBe(false);
    const url = new URL(buildStripeAuthorizeUrl({ clientId: 'ca_1', redirectUri: 'https://app/cb', state }));
    expect(url.origin + url.pathname).toBe('https://connect.stripe.com/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('read_write');
    expect(url.searchParams.get('state')).toBe(state);
  });

  it('exchanges the code with the platform key and keeps the account id', async () => {
    const { calls, fetchImpl } = recorder(() => json({ stripe_user_id: 'acct_7', livemode: true, scope: 'read_write' }));
    const tokens = await exchangeStripeCode({ secretKey: 'sk_live_p', code: 'ac_1', fetchImpl });
    expect(tokens).toMatchObject({ stripeUserId: 'acct_7', accessToken: null, livemode: true });
    expect(header(calls[0], 'authorization')).toBe(`Basic ${btoa('sk_live_p:')}`);
  });

  it('surfaces Stripe OAuth errors and treats an already-revoked account as disconnected', async () => {
    const failing = recorder(() => json({ error: 'invalid_grant', error_description: 'Authorization code expired' }, 400));
    await expect(exchangeStripeCode({ secretKey: 'sk', code: 'x', fetchImpl: failing.fetchImpl })).rejects.toThrow('Authorization code expired');
    const revoked = recorder(() => json({ error: 'invalid_client' }, 401));
    await expect(
      deauthorizeStripeAccount({ secretKey: 'sk', clientId: 'ca', stripeUserId: 'acct', fetchImpl: revoked.fetchImpl }),
    ).resolves.toBeUndefined();
  });
});

describe('Stripe webhooks', () => {
  it('maps events to syncs and unwraps the object', () => {
    expect(matchWebhookTopic('stripe', 'invoice.paid')?.syncName).toBe('stripe-invoices');
    expect(matchWebhookTopic('stripe', 'payout.paid')?.syncName).toBe('stripe-balance-transactions');
    expect(matchWebhookTopic('stripe', 'customer.created')).toBeUndefined();
    const event = { type: 'invoice.paid', data: { object: { id: 'in_1' } } };
    expect(readWebhookTopicFromPayload('stripe', event)).toBe('invoice.paid');
    expect(unwrapWebhookPayload('stripe', event)).toEqual({ id: 'in_1' });
    expect(readWebhookSignatureFromHeaders('stripe', new Headers({ 'Stripe-Signature': 't=1,v1=a' }))).toBe('t=1,v1=a');
  });

  it('verifies Stripe-Signature (t + v1) within the tolerance', async () => {
    const body = '{"id":"evt_1"}';
    const now = 1_767_225_600;
    const v1 = await hmacSha256Hex('whsec_x', `${now}.${body}`);
    const signature = `t=${now},v1=${v1},v0=legacy`;
    expect(await verifyStripeWebhook({ secret: 'whsec_x', body, signature, nowSeconds: now + 10 })).toBe(true);
    expect(await verifyStripeWebhook({ secret: 'whsec_x', body, signature, nowSeconds: now + 600 })).toBe(false);
    expect(await verifyStripeWebhook({ secret: 'other', body, signature, nowSeconds: now })).toBe(false);
  });

  it('re-reads a payout into its lines when a payout.paid event arrives', async () => {
    const { fetchImpl } = recorder((url) => {
      if (url.pathname === '/v1/payouts/po_1') {
        return json({ id: 'po_1', status: 'paid', amount: 100, currency: 'eur', created: 1767225600, automatic: false });
      }
      return json({ data: [], has_more: false });
    });
    const client = new StripeClient({ apiKey: 'rk' }, { fetchImpl });
    const lines = await client.hydrateWebhookRecords(linesSync, { id: 'po_1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ line: 'payout', amount: -100, payout_id: 'po_1' });
  });
});

describe('Stripe field mappings', () => {
  it('seeds none: the Stripe mapper owns every field', () => {
    expect(getDefaultConnectorFieldMappings('invoice', 'stripe')).toEqual([]);
    expect(getDefaultConnectorFieldMappings('bank_transaction', 'stripe')).toEqual([]);
    expect(getDefaultConnectorFieldMappings('invoice', 'moneybird').length).toBeGreaterThan(0);
  });
});
