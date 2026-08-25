import { describe, it, expect } from 'vitest';
import { ConnectorApiError } from '../types';
import { normalizeStoreUrl, WooCommerceClient } from './client';

describe('normalizeStoreUrl', () => {
  it('strips trailing slashes and adds https when missing', () => {
    expect(normalizeStoreUrl('mystore.com/')).toBe('https://mystore.com');
    expect(normalizeStoreUrl('https://mystore.com/shop/')).toBe('https://mystore.com/shop');
  });

  it('rejects an empty or invalid URL', () => {
    expect(() => normalizeStoreUrl('')).toThrow(ConnectorApiError);
    expect(() => normalizeStoreUrl('not a url')).toThrow(ConnectorApiError);
  });
});

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

describe('WooCommerceClient', () => {
  it('sends Basic auth without query-string secrets and paginates off WP total headers', async () => {
    const calls: Array<{ url: string; authorization: string | null; userAgent: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        authorization: headers.get('Authorization'),
        userAgent: headers.get('User-Agent'),
      });
      return jsonResponse([{ id: 1, name: 'Tee' }], {
        headers: {
          'x-wp-totalpages': '3',
          'x-wp-total': '250',
        },
      });
    };

    const client = new WooCommerceClient(
      { storeUrl: 'https://shop.example', consumerKey: 'ck_a', consumerSecret: 'cs_b' },
      { fetchImpl },
    );
    const page = await client.listProducts({ page: 2, perPage: 100, modifiedAfter: '2026-01-01T00:00:00' });

    expect(page.totalPages).toBe(3);
    expect(page.total).toBe(250);
    expect(page.items).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/wp-json/wc/v3/products');
    expect(calls[0]!.url).toContain('page=2');
    expect(calls[0]!.url).toContain('modified_after=2026-01-01T00%3A00%3A00');
    expect(calls[0]!.url).not.toContain('consumer_key');
    expect(calls[0]!.url).not.toContain('consumer_secret');
    expect(calls[0]!.authorization).toMatch(/^Basic /);
    expect(atob(calls[0]!.authorization!.slice('Basic '.length))).toBe('ck_a:cs_b');
    expect(calls[0]!.userAgent).toMatch(/WeldSuite-WooCommerce/);
  });

  it('uses HTTPS and Postman-style Basic Auth even when the stored URL is http', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return jsonResponse([]);
    };
    const client = new WooCommerceClient(
      { storeUrl: 'http://shop.example', consumerKey: 'ck_a', consumerSecret: 'cs_b' },
      { fetchImpl },
    );
    await client.listProducts();
    expect(calls[0]).toMatch(/^https:\/\/shop\.example\/wp-json\/wc\/v3\/products/);
    expect(calls[0]).not.toContain('consumer_secret');
  });

  it('retries with query-string auth when the host strips Basic Auth (401)', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      calls.push({ url, authorization: headers.get('Authorization') });
      if (url.includes('consumer_key=ck_a')) {
        return jsonResponse([{ id: 9 }]);
      }
      return new Response('denied', { status: 401 });
    };

    const client = new WooCommerceClient(
      { storeUrl: 'https://shop.example', consumerKey: 'ck_a', consumerSecret: 'cs_b' },
      { fetchImpl },
    );
    const page = await client.listProducts();
    expect(page.items).toEqual([{ id: 9 }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.authorization).toMatch(/^Basic /);
    expect(calls[0]!.url).not.toContain('consumer_secret');
    expect(calls[1]!.authorization).toBeNull();
    expect(calls[1]!.url).toContain('consumer_key=ck_a');
    expect(calls[1]!.url).toContain('consumer_secret=cs_b');
  });

  it('follows a cross-host redirect while keeping the Authorization header', async () => {
    const calls: Array<{ url: string; authorization: string | null; redirect?: RequestRedirect }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      calls.push({ url, authorization: headers.get('Authorization'), redirect: init?.redirect });
      if (url.startsWith('https://shop.example/')) {
        return new Response(null, {
          status: 301,
          headers: { Location: 'https://www.shop.example/wp-json/wc/v3/products?page=1&per_page=100' },
        });
      }
      return jsonResponse([]);
    };

    const client = new WooCommerceClient(
      { storeUrl: 'https://shop.example', consumerKey: 'ck_a', consumerSecret: 'cs_b' },
      { fetchImpl },
    );
    await client.listProducts();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.redirect).toBe('manual');
    expect(calls[1]!.url).toContain('https://www.shop.example/wp-json/wc/v3/products');
    expect(calls[1]!.authorization).toMatch(/^Basic /);
    expect(calls[1]!.url).not.toContain('consumer_secret');
  });

  it('falls back to ?rest_route= when /wp-json/ returns a web page', async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/wp-json/')) {
        return new Response('<!doctype html><html><head></head><body>Home</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return jsonResponse([{ id: 3 }], {
        headers: { 'x-wp-totalpages': '1', 'x-wp-total': '1' },
      });
    };

    const client = new WooCommerceClient(
      { storeUrl: 'https://shop.example/store', consumerKey: 'ck_a', consumerSecret: 'cs_b' },
      { fetchImpl },
    );
    const page = await client.listProducts();
    expect(page.items).toEqual([{ id: 3 }]);
    expect(urls[0]).toContain('/store/wp-json/wc/v3/products');
    expect(urls[1]).toContain('rest_route=%2Fwc%2Fv3%2Fproducts');
    expect(urls[1]).toContain('https://shop.example/store');
    expect(urls[1]).not.toContain('/wp-json/');
  });

  it('does not treat product HTML in JSON as a web page', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse([{ id: 2, description: '<html><body>Sale</body></html>' }]);
    const client = new WooCommerceClient(
      { storeUrl: 'https://shop.example', consumerKey: 'ck_a', consumerSecret: 'cs_b' },
      { fetchImpl },
    );
    const page = await client.listProducts();
    expect(page.items).toEqual([{ id: 2, description: '<html><body>Sale</body></html>' }]);
  });

  it('parses JSON that PHP warnings prepended', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('Notice: Undefined offset: 0 in wp-includes/foo.php on line 1\n[{"id":4}]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const client = new WooCommerceClient(
      { storeUrl: 'https://shop.example', consumerKey: 'ck_a', consumerSecret: 'cs_b' },
      { fetchImpl },
    );
    const page = await client.listProducts();
    expect(page.items).toEqual([{ id: 4 }]);
  });

  it('surfaces the underlying network error instead of a generic unreachable message', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('Network connection lost.');
    };
    const client = new WooCommerceClient(
      { storeUrl: 'https://shop.example', consumerKey: 'ck_a', consumerSecret: 'cs_b' },
      { fetchImpl, timeoutMs: 20 },
    );
    await expect(client.listProducts()).rejects.toMatchObject({
      message: 'Could not reach the WooCommerce store (Network connection lost.)',
      status: 503,
    });
  });

  it('maps 401 on both auth modes to an auth error on test()', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response('denied', { status: 401 });
    };
    const client = new WooCommerceClient(
      { storeUrl: 'https://shop.example', consumerKey: 'ck_a', consumerSecret: 'cs_b' },
      { fetchImpl },
    );
    const result = await client.test();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/rejected/i);
    }
    expect(calls).toBe(2);
  });

  it('does not invoke fetch with the client as this (Cloudflare Workers Illegal invocation)', async () => {
    function workersFetch(this: unknown) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError(
          'Illegal invocation: function called with incorrect `this` reference.',
        );
      }
      return jsonResponse([]);
    }
    const client = new WooCommerceClient(
      { storeUrl: 'https://shop.example', consumerKey: 'ck_a', consumerSecret: 'cs_b' },
      { fetchImpl: workersFetch as typeof fetch },
    );
    await expect(client.listProducts()).resolves.toMatchObject({ items: [] });
  });

  it('creates a product and looks one up by SKU', async () => {
    const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: String(init?.method ?? 'GET'), body: init?.body ? String(init.body) : undefined });
      if (url.includes('sku=WH-1')) {
        return new Response(JSON.stringify([{ id: 12, permalink: 'https://shop.example/?p=12' }]), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 99, permalink: 'https://shop.example/?p=99' }), { status: 201 });
    };

    const client = new WooCommerceClient(
      { storeUrl: 'https://shop.example', consumerKey: 'ck_a', consumerSecret: 'cs_b' },
      { fetchImpl },
    );

    const created = await client.createProduct({ name: 'Helmet', price: '19.00', status: 'active', sku: 'WH-1' });
    expect(created).toEqual({ id: '99', url: 'https://shop.example/?p=99' });
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({
      name: 'Helmet',
      type: 'simple',
      status: 'publish',
      sku: 'WH-1',
      regular_price: '19.00',
    });

    const draft = await client.createProduct({ name: 'Gloves', price: '9.00', status: 'inactive' });
    expect(draft.id).toBe('99');
    expect(JSON.parse(calls[1]?.body ?? '{}')).toMatchObject({ status: 'private', regular_price: '9.00' });

    const found = await client.findProductBySku('WH-1');
    expect(found).toEqual({ id: '12', url: 'https://shop.example/?p=12' });
    expect(await client.findProductBySku('  ')).toBeNull();
  });

  it('probes hasUpdatesSince with per_page=1 and treats an empty page as no changes', async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return jsonResponse([]);
    };
    const client = new WooCommerceClient(
      { storeUrl: 'https://shop.example', consumerKey: 'ck_a', consumerSecret: 'cs_b' },
      { fetchImpl },
    );
    expect(await client.hasUpdatesSince('products', '2026-01-01T00:00:00')).toBe(false);
    expect(urls[0]).toContain('per_page=1');
    expect(urls[0]).toContain('modified_after=2026-01-01T00%3A00%3A00');
  });

  it('does not treat unsupported modified_after as "everything changed"', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"code":"rest_invalid_param"}', { status: 400, headers: { 'content-type': 'application/json' } });
    const client = new WooCommerceClient(
      { storeUrl: 'https://shop.example', consumerKey: 'ck_a', consumerSecret: 'cs_b' },
      { fetchImpl },
    );
    expect(await client.hasUpdatesSince('customers', '2026-01-01T00:00:00')).toBe(false);
  });
});
