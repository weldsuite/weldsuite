import { afterEach, describe, expect, it, vi } from 'vitest';

import { createIdempotencyKey, createStorefrontClient, paginate, type StorefrontClient } from './client.ts';
import { StorefrontError, isStorefrontError } from './errors.ts';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A client whose fetch answers from `answer` and records each request. */
function setup(
  answer: (req: Recorded) => Response = () => json(200, { data: {} }),
  options: Partial<Parameters<typeof createStorefrontClient>[0]> = {},
) {
  const calls: Recorded[] = [];
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    const req: Recorded = {
      url: input,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    return answer(req);
  });
  const client = createStorefrontClient({ baseUrl: 'https://api.example.test', key: 'wcs_secret', fetch, ...options });
  return { client, calls, fetch };
}

const BASE = 'https://api.example.test/storefront/v1';

describe('createStorefrontClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('accepts only storefront keys', () => {
    expect(() => createStorefrontClient({ baseUrl: 'https://a.test', key: 'wsk_x' })).toThrow(TypeError);
    expect(() => createStorefrontClient({ baseUrl: 'https://a.test', key: '' })).toThrow(TypeError);
    expect(() => createStorefrontClient({ baseUrl: 'https://a.test', key: 'wcp_x' })).not.toThrow();
  });

  it('needs an absolute base URL and adds /storefront/v1 once', async () => {
    expect(() => createStorefrontClient({ baseUrl: '/api', key: 'wcp_x' })).toThrow(TypeError);
    for (const baseUrl of ['https://api.example.test', 'https://api.example.test/', 'https://api.example.test/storefront/v1/']) {
      const { client, calls } = setup(undefined, { baseUrl });
      await client.channel.get();
      expect(calls[0]?.url).toBe(`${BASE}/channel`);
    }
  });

  it('refuses a private key in a browser', () => {
    vi.stubGlobal('document', {});
    expect(() => createStorefrontClient({ baseUrl: 'https://a.test', key: 'wcs_x' })).toThrow(/never be used in a browser/);
    expect(() =>
      createStorefrontClient({ baseUrl: 'https://a.test', key: 'wcs_x', allowPrivateKeyInBrowser: true }),
    ).not.toThrow();
    expect(() => createStorefrontClient({ baseUrl: 'https://a.test', key: 'wcp_x' })).not.toThrow();
  });

  it('sends shopperIp only with a private key', async () => {
    expect(() => createStorefrontClient({ baseUrl: 'https://a.test', key: 'wcp_x', shopperIp: '1.2.3.4' })).toThrow(
      TypeError,
    );
    const publishable = setup(undefined, { key: 'wcp_public' });
    await expect(publishable.client.channel.get({ shopperIp: '1.2.3.4' })).rejects.toThrow(TypeError);
    expect(publishable.calls).toHaveLength(0);

    const { client, calls } = setup(undefined, { shopperIp: '9.9.9.9' });
    await client.channel.get();
    await client.channel.get({ shopperIp: '1.2.3.4' });
    expect(calls[0]?.headers['X-Shopper-Ip']).toBe('9.9.9.9');
    expect(calls[1]?.headers['X-Shopper-Ip']).toBe('1.2.3.4');
  });

  it('uses the global fetch when none is given', async () => {
    const fetch = vi.fn(async () => json(200, { data: { id: 'ch_1' } }));
    vi.stubGlobal('fetch', fetch);
    const client = createStorefrontClient({ baseUrl: 'https://a.test', key: 'wcp_x' });
    await expect(client.channel.get()).resolves.toEqual({ id: 'ch_1' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('headers', () => {
  it('sends the key, Accept and a JSON content type only with a body', async () => {
    const { client, calls } = setup();
    await client.channel.get();
    await client.cart.create({ email: 'a@b.test' });
    expect(calls[0]?.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer wcs_secret' });
    expect(calls[1]?.headers['Content-Type']).toBe('application/json');
  });

  it('sends the cart and shopper tokens', async () => {
    const { client, calls } = setup();
    await client.cart.get('wct_cart', { shopperToken: 'wss_session' });
    expect(calls[0]?.headers['X-Cart-Token']).toBe('wct_cart');
    expect(calls[0]?.headers['X-Shopper-Token']).toBe('wss_session');
    await client.account.get('wss_session');
    expect(calls[1]?.headers['X-Shopper-Token']).toBe('wss_session');
    expect(calls[1]?.headers['X-Cart-Token']).toBeUndefined();
  });

  it('sends Idempotency-Key on checkout', async () => {
    const { client, calls } = setup(() => json(201, { data: { order: {}, payment: null, orderToken: null } }));
    await client.cart.checkout('wct_cart', { paymentMethod: 'invoice' }, { idempotencyKey: 'key-1' });
    expect(calls[0]?.headers['Idempotency-Key']).toBe('key-1');
  });

  it('refuses a call without the token it needs, before sending anything', async () => {
    const { client, calls } = setup();
    await expect(client.cart.get('')).rejects.toThrow(/cartToken is required/);
    await expect(client.account.get('  ')).rejects.toThrow(/shopperToken is required/);
    await expect(client.orders.getGuest('ord_1', '')).rejects.toThrow(/orderToken is required/);
    await expect(client.products.get('')).rejects.toThrow(/idOrSlug is required/);
    expect(calls).toHaveLength(0);
  });
});

type Case = {
  name: string;
  run: (c: StorefrontClient) => Promise<unknown>;
  method: string;
  path: string;
  body?: unknown;
  cartToken?: string;
  shopperToken?: string;
  status?: number;
};

const T = 'wct_t';
const S = 'wss_s';

const cases: Case[] = [
  { name: 'channel.get', run: (c) => c.channel.get(), method: 'GET', path: '/channel' },
  {
    name: 'products.list',
    run: (c) => c.products.list({ category: 'shoes', search: 'red sneaker', sort: '-price', cursor: 'p_9', limit: 10 }),
    method: 'GET',
    path: '/products?category=shoes&search=red+sneaker&sort=-price&cursor=p_9&limit=10',
  },
  { name: 'products.list without params', run: (c) => c.products.list(), method: 'GET', path: '/products' },
  {
    name: 'products.list with request options only',
    run: (c) => c.products.list({ signal: new AbortController().signal }),
    method: 'GET',
    path: '/products',
  },
  { name: 'products.get', run: (c) => c.products.get('blue shirt/1'), method: 'GET', path: '/products/blue%20shirt%2F1' },
  { name: 'categories.list', run: (c) => c.categories.list(), method: 'GET', path: '/categories' },
  { name: 'categories.get', run: (c) => c.categories.get('summer'), method: 'GET', path: '/categories/summer' },
  {
    name: 'cart.create',
    run: (c) =>
      c.cart.create({
        items: [{ variantId: 'v_1', quantity: 2 }],
        email: 'a@b.test',
        shopperToken: S,
        signal: new AbortController().signal,
      }),
    method: 'POST',
    path: '/carts',
    body: { items: [{ variantId: 'v_1', quantity: 2 }], email: 'a@b.test' },
    shopperToken: S,
    status: 201,
  },
  { name: 'cart.create empty', run: (c) => c.cart.create(), method: 'POST', path: '/carts', body: {}, status: 201 },
  { name: 'cart.get', run: (c) => c.cart.get(T), method: 'GET', path: '/cart', cartToken: T },
  {
    name: 'cart.addItem',
    run: (c) => c.cart.addItem(T, { productId: 'p_1', quantity: 1 }),
    method: 'POST',
    path: '/cart/items',
    body: { productId: 'p_1', quantity: 1 },
    cartToken: T,
  },
  {
    name: 'cart.updateItem',
    run: (c) => c.cart.updateItem(T, 'cl_1', 3),
    method: 'PATCH',
    path: '/cart/items/cl_1',
    body: { quantity: 3 },
    cartToken: T,
  },
  { name: 'cart.removeItem', run: (c) => c.cart.removeItem(T, 'cl_1'), method: 'DELETE', path: '/cart/items/cl_1', cartToken: T },
  {
    name: 'cart.update',
    run: (c) =>
      c.cart.update(T, {
        email: 'a@b.test',
        shippingAddress: { name: 'A', line1: 'Straat 1', city: 'Utrecht', postalCode: '3511 AA', country: 'NL' },
        billingAddress: null,
        buyerVatNumber: 'NL123456789B01',
        customerReference: 'PO-7',
        note: null,
      }),
    method: 'PATCH',
    path: '/cart',
    body: {
      email: 'a@b.test',
      shippingAddress: { name: 'A', line1: 'Straat 1', city: 'Utrecht', postalCode: '3511 AA', country: 'NL' },
      billingAddress: null,
      buyerVatNumber: 'NL123456789B01',
      customerReference: 'PO-7',
      note: null,
    },
    cartToken: T,
  },
  { name: 'cart.shippingRates', run: (c) => c.cart.shippingRates(T), method: 'GET', path: '/cart/shipping-rates', cartToken: T },
  {
    name: 'cart.setShippingRate',
    run: (c) => c.cart.setShippingRate(T, 'sr_1'),
    method: 'PUT',
    path: '/cart/shipping-rate',
    body: { shippingRateId: 'sr_1' },
    cartToken: T,
  },
  {
    name: 'cart.applyDiscount',
    run: (c) => c.cart.applyDiscount(T, 'SUMMER10'),
    method: 'POST',
    path: '/cart/discount',
    body: { code: 'SUMMER10' },
    cartToken: T,
  },
  { name: 'cart.removeDiscount', run: (c) => c.cart.removeDiscount(T), method: 'DELETE', path: '/cart/discount', cartToken: T },
  {
    name: 'cart.checkout',
    run: (c) =>
      c.cart.checkout(
        T,
        {
          paymentMethod: 'mollie',
          expectedTotal: '24.95',
          redirectUrl: 'https://shop.test/checkout/return',
          orderUrl: 'https://shop.test/orders/{orderId}?token={token}',
        },
        { shopperToken: S },
      ),
    method: 'POST',
    path: '/cart/checkout',
    body: {
      paymentMethod: 'mollie',
      expectedTotal: '24.95',
      redirectUrl: 'https://shop.test/checkout/return',
      orderUrl: 'https://shop.test/orders/{orderId}?token={token}',
    },
    cartToken: T,
    shopperToken: S,
    status: 201,
  },
  {
    name: 'cart.quickOrder with a cart',
    run: (c) => c.cart.quickOrder({ csv: 'sku,quantity\nA-1,2' }, { cartToken: T, shopperToken: S }),
    method: 'POST',
    path: '/cart/quick-order',
    body: { csv: 'sku,quantity\nA-1,2' },
    cartToken: T,
    shopperToken: S,
  },
  {
    name: 'cart.quickOrder without a cart',
    run: (c) => c.cart.quickOrder({ lines: [{ sku: 'A-1', quantity: 2 }] }),
    method: 'POST',
    path: '/cart/quick-order',
    body: { lines: [{ sku: 'A-1', quantity: 2 }] },
  },
  { name: 'payments.get', run: (c) => c.payments.get('pay_1'), method: 'GET', path: '/payments/pay_1' },
  { name: 'payments.retry', run: (c) => c.payments.retry('pay_1'), method: 'POST', path: '/payments/pay_1/retry', status: 201 },
  {
    name: 'auth.requestCode',
    run: (c) => c.auth.requestCode('a@b.test'),
    method: 'POST',
    path: '/auth/code',
    body: { email: 'a@b.test' },
    status: 202,
  },
  {
    name: 'auth.requestCode with a locale',
    run: (c) => c.auth.requestCode('a@b.test', { locale: 'nl' }),
    method: 'POST',
    path: '/auth/code',
    body: { email: 'a@b.test', locale: 'nl' },
    status: 202,
  },
  {
    name: 'auth.verify',
    run: (c) => c.auth.verify('a@b.test', '012345'),
    method: 'POST',
    path: '/auth/verify',
    body: { email: 'a@b.test', code: '012345' },
  },
  { name: 'auth.signOut', run: (c) => c.auth.signOut(S), method: 'POST', path: '/auth/sign-out', shopperToken: S, status: 204 },
  { name: 'account.get', run: (c) => c.account.get(S), method: 'GET', path: '/account', shopperToken: S },
  {
    name: 'account.update',
    run: (c) => c.account.update(S, { firstName: 'Ada', phone: null }),
    method: 'PATCH',
    path: '/account',
    body: { firstName: 'Ada', phone: null },
    shopperToken: S,
  },
  {
    name: 'account.selectCompany',
    run: (c) => c.account.selectCompany(S, 'co_1'),
    method: 'PUT',
    path: '/account/company',
    body: { companyId: 'co_1' },
    shopperToken: S,
  },
  {
    name: 'account.selectCompany null',
    run: (c) => c.account.selectCompany(S, null),
    method: 'PUT',
    path: '/account/company',
    body: { companyId: null },
    shopperToken: S,
  },
  {
    name: 'orders.list',
    run: (c) => c.orders.list(S, { cursor: 'o_5', limit: 20 }),
    method: 'GET',
    path: '/account/orders?cursor=o_5&limit=20',
    shopperToken: S,
  },
  { name: 'orders.get', run: (c) => c.orders.get(S, 'ord_1'), method: 'GET', path: '/account/orders/ord_1', shopperToken: S },
  {
    name: 'orders.getGuest',
    run: (c) => c.orders.getGuest('ord_1', 'wgo_tok+en'),
    method: 'GET',
    path: '/orders/ord_1?token=wgo_tok%2Ben',
  },
  {
    name: 'orders.reorder',
    run: (c) => c.orders.reorder(S, 'ord_1', { cartToken: T }),
    method: 'POST',
    path: '/account/orders/ord_1/reorder',
    cartToken: T,
    shopperToken: S,
  },
  { name: 'approvals.list', run: (c) => c.approvals.list(S), method: 'GET', path: '/account/approvals', shopperToken: S },
  {
    name: 'approvals.approve',
    run: (c) => c.approvals.approve(S, 'ord_1', { comment: 'OK' }),
    method: 'POST',
    path: '/account/approvals/ord_1/approve',
    body: { comment: 'OK' },
    shopperToken: S,
  },
  {
    name: 'approvals.reject',
    run: (c) => c.approvals.reject(S, 'ord_1'),
    method: 'POST',
    path: '/account/approvals/ord_1/reject',
    body: {},
    shopperToken: S,
  },
  { name: 'buyers.list', run: (c) => c.buyers.list(S), method: 'GET', path: '/account/buyers', shopperToken: S },
  {
    name: 'buyers.invite',
    run: (c) => c.buyers.invite(S, { email: 'b@c.test', role: 'buyer', spendLimit: '500.00' }),
    method: 'POST',
    path: '/account/buyers',
    body: { email: 'b@c.test', role: 'buyer', spendLimit: '500.00' },
    shopperToken: S,
    status: 201,
  },
  {
    name: 'buyers.update',
    run: (c) => c.buyers.update(S, 'cb_1', { role: 'approver', spendLimit: null }),
    method: 'PATCH',
    path: '/account/buyers/cb_1',
    body: { role: 'approver', spendLimit: null },
    shopperToken: S,
  },
  { name: 'buyers.remove', run: (c) => c.buyers.remove(S, 'cb_1'), method: 'DELETE', path: '/account/buyers/cb_1', shopperToken: S, status: 204 },
];

describe('every route', () => {
  it.each(cases)('$name: $method $path', async (c) => {
    const status = c.status ?? 200;
    const { client, calls } = setup(() => (status === 204 ? new Response(null, { status }) : json(status, { data: { ok: c.name } })));
    const result = await c.run(client);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe(c.method);
    expect(call.url).toBe(BASE + c.path);
    expect(call.body).toEqual(c.body);
    expect(call.headers['X-Cart-Token']).toBe(c.cartToken);
    expect(call.headers['X-Shopper-Token']).toBe(c.shopperToken);
    expect(call.headers.Authorization).toBe('Bearer wcs_secret');
    if (status === 204) expect(result).toBeUndefined();
    else if (c.path.startsWith('/products?') || c.path === '/products' || c.path.startsWith('/account/orders?')) {
      expect(result).toEqual({ data: { ok: c.name }, pagination: { hasMore: false, cursor: null } });
    } else expect(result).toEqual({ ok: c.name });
  });

  it('covers every method of the client', () => {
    const { client } = setup();
    const methods = Object.entries(client).flatMap(([ns, group]) =>
      Object.keys(group as object).map((m) => `${ns}.${m}`),
    );
    const tested = new Set(cases.map((c) => c.name.split(' ')[0]));
    // iterate() is tested with pagination below.
    const untested = methods.filter((m) => !tested.has(m) && !m.endsWith('.iterate'));
    expect(untested).toEqual([]);
  });

  it('unwraps data and keeps pagination', async () => {
    const { client } = setup(() =>
      json(200, { data: [{ id: 'p_1' }], pagination: { hasMore: true, cursor: 'p_1' } }),
    );
    await expect(client.products.list()).resolves.toEqual({
      data: [{ id: 'p_1' }],
      pagination: { hasMore: true, cursor: 'p_1' },
    });
  });
});

describe('pagination', () => {
  it('iterates products page by page with the cursor', async () => {
    const pages: Record<string, unknown> = {
      '': { data: [{ id: 'a' }, { id: 'b' }], pagination: { hasMore: true, cursor: 'b' } },
      b: { data: [{ id: 'c' }], pagination: { hasMore: true, cursor: 'c' } },
      c: { data: [{ id: 'd' }], pagination: { hasMore: false, cursor: null } },
    };
    const { client, calls } = setup((req) => json(200, pages[new URL(req.url).searchParams.get('cursor') ?? '']));
    const ids: string[] = [];
    for await (const product of client.products.iterate({ category: 'shoes', limit: 2 })) ids.push(product.id);
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/products?category=shoes&limit=2`,
      `${BASE}/products?category=shoes&cursor=b&limit=2`,
      `${BASE}/products?category=shoes&cursor=c&limit=2`,
    ]);
  });

  it('iterates a shopper’s orders', async () => {
    const { client, calls } = setup((req) =>
      new URL(req.url).searchParams.get('cursor')
        ? json(200, { data: [{ id: 'o2' }], pagination: { hasMore: false, cursor: null } })
        : json(200, { data: [{ id: 'o1' }], pagination: { hasMore: true, cursor: 'o1' } }),
    );
    const ids: string[] = [];
    for await (const order of client.orders.iterate(S)) ids.push(order.id);
    expect(ids).toEqual(['o1', 'o2']);
    expect(calls.every((c) => c.headers['X-Shopper-Token'] === S)).toBe(true);
  });

  it('stops when a page says hasMore without a cursor, and can stop early', async () => {
    const load = vi.fn(async () => ({ data: [1, 2], pagination: { hasMore: true, cursor: null } }));
    const seen: number[] = [];
    for await (const n of paginate(load)) seen.push(n);
    expect(seen).toEqual([1, 2]);
    expect(load).toHaveBeenCalledOnce();

    const endless = vi.fn(async (cursor: string | undefined) => ({
      data: [Number(cursor ?? 0) + 1],
      pagination: { hasMore: true, cursor: String(Number(cursor ?? 0) + 1) },
    }));
    for await (const n of paginate(endless)) if (n >= 3) break;
    expect(endless).toHaveBeenCalledTimes(3);
  });
});

describe('errors', () => {
  it('maps the error body to a StorefrontError', async () => {
    const { client } = setup(() =>
      json(409, {
        error: {
          code: 'OUT_OF_STOCK',
          message: 'Some items are no longer in stock',
          details: { lines: [{ lineId: 'cl_1', available: 1 }] },
        },
      }),
    );
    const error = await client.cart.checkout(T, { paymentMethod: 'mollie' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorefrontError);
    expect(error).toBeInstanceOf(Error);
    expect(isStorefrontError(error, 'OUT_OF_STOCK')).toBe(true);
    expect(isStorefrontError(error, 'PRICE_CHANGED')).toBe(false);
    expect(isStorefrontError(error)).toBe(true);
    if (!isStorefrontError(error, 'OUT_OF_STOCK')) throw new Error('unreachable');
    expect(error.status).toBe(409);
    expect(error.message).toBe('Some items are no longer in stock');
    expect(error.details.lines[0]).toEqual({ lineId: 'cl_1', available: 1 });
    expect(error.retryAfter).toBeNull();
    expect(error.name).toBe('StorefrontError');
  });

  it('maps a validation error with its fields', async () => {
    const { client } = setup(() =>
      json(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request is not valid',
          details: { fields: { 'shippingAddress.country': 'Must be a 2-letter country code' } },
        },
      }),
    );
    const error = await client.cart.update(T, { shippingAddress: { country: 'Holland' } }).catch((e: unknown) => e);
    if (!isStorefrontError(error, 'VALIDATION_ERROR')) throw new Error('expected a validation error');
    expect(error.details.fields['shippingAddress.country']).toMatch(/2-letter/);
  });

  it('maps the session and cursor refusals', async () => {
    const answers: Record<string, Response> = {
      '/account': json(401, { error: { code: 'SESSION_EXPIRED', message: 'The session has expired: sign in again' } }),
      '/products': json(400, { error: { code: 'INVALID_CURSOR', message: 'The cursor is not one this list gave out' } }),
    };
    const { client } = setup((req) => answers[new URL(req.url).pathname.replace('/storefront/v1', '')]!);
    const expired = await client.account.get(S).catch((e: unknown) => e);
    expect(isStorefrontError(expired, 'SESSION_EXPIRED', 'SESSION_REQUIRED')).toBe(true);
    expect(expired).toMatchObject({ status: 401 });
    const cursor = await client.products.list({ cursor: 'stale' }).catch((e: unknown) => e);
    expect(isStorefrontError(cursor, 'INVALID_CURSOR')).toBe(true);
  });

  it('returns an approved order with its payment', async () => {
    const payment = { id: 'cpay_1', status: 'open', checkoutUrl: 'https://mollie.test/pay' };
    const { client } = setup(() => json(200, { data: { id: 'ord_1', approvalStatus: 'approved', payment } }));
    const order = await client.approvals.approve(S, 'ord_1');
    expect(order.payment).toEqual(payment);
    expect(order.approvalStatus).toBe('approved');
  });

  it('reads an error answer without a body as UNEXPECTED_RESPONSE', async () => {
    const { client } = setup(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const error = await client.channel.get().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: 'UNEXPECTED_RESPONSE' });
  });

  it('reads a success answer without data as UNEXPECTED_RESPONSE', async () => {
    const { client } = setup(() => json(200, { nope: true }));
    await expect(client.channel.get()).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('wraps a failed fetch as NETWORK_ERROR with the cause', async () => {
    const cause = new TypeError('fetch failed');
    const { client } = setup(() => {
      throw cause;
    });
    const error = await client.channel.get().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    expect((error as Error).cause).toBe(cause);
  });

  it('lets an abort through unchanged', async () => {
    const controller = new AbortController();
    const { client } = setup((req) => {
      expect(req).toBeDefined();
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    controller.abort();
    const error = await client.channel.get({ signal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
  });

  it('passes the signal to fetch', async () => {
    const controller = new AbortController();
    const { client, fetch } = setup();
    await client.channel.get({ signal: controller.signal });
    expect(fetch.mock.calls[0]?.[1].signal).toBe(controller.signal);
  });
});

describe('rate limits', () => {
  const limited = () =>
    json(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, { 'Retry-After': '7' });

  it('throws RATE_LIMITED with retryAfter by default', async () => {
    const { client, calls } = setup(limited);
    const error = await client.cart.addItem(T, { productId: 'p_1', quantity: 1 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfter: 7 });
    expect(calls).toHaveLength(1);
  });

  it('reads Retry-After on other answers too (WORKSPACE_MOVING)', async () => {
    const { client } = setup(() =>
      json(503, { error: { code: 'WORKSPACE_MOVING', message: 'Moving' } }, { 'Retry-After': '30' }),
    );
    await expect(client.channel.get()).rejects.toMatchObject({ code: 'WORKSPACE_MOVING', retryAfter: 30 });
  });

  it('retries after Retry-After when asked to', async () => {
    vi.useFakeTimers();
    let n = 0;
    const { client, calls } = setup(
      () => (n++ === 0 ? limited() : json(200, { data: { id: 'ch_1' } })),
      { rateLimitRetries: 2 },
    );
    const promise = client.channel.get();
    await vi.advanceTimersByTimeAsync(6_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ id: 'ch_1' });
    expect(calls).toHaveLength(2);
  });

  it('gives up after rateLimitRetries, or when Retry-After is too long', async () => {
    vi.useFakeTimers();
    const { client, calls } = setup(limited, { rateLimitRetries: 1 });
    const promise = client.channel.get().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(promise).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(calls).toHaveLength(2);

    const long = setup(limited, { rateLimitRetries: 3, maxRetryAfter: 5 });
    await expect(long.client.channel.get()).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 7 });
    expect(long.calls).toHaveLength(1);
  });

  it('stops waiting when the request is aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { client, calls } = setup(limited, { rateLimitRetries: 1 });
    const promise = client.channel.get({ signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    const error = await promise;
    expect((error as Error).name).toBe('AbortError');
    expect(calls).toHaveLength(1);
  });
});

describe('createIdempotencyKey', () => {
  it('makes a different key each time', () => {
    const a = createIdempotencyKey();
    const b = createIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});
