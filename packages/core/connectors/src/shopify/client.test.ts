import { describe, it, expect } from 'vitest';
import { ConnectorApiError } from '../types';
import { normalizeShopDomain, ShopifyClient } from './client';

describe('normalizeShopDomain', () => {
  it('accepts a bare shop name and a full myshopify host', () => {
    expect(normalizeShopDomain('mystore')).toBe('mystore.myshopify.com');
    expect(normalizeShopDomain('https://mystore.myshopify.com/')).toBe('mystore.myshopify.com');
  });

  it('rejects an empty domain', () => {
    expect(() => normalizeShopDomain('')).toThrow(ConnectorApiError);
  });
});

describe('ShopifyClient', () => {
  it('sends the Admin API token and follows Link pagination', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ products: [{ id: 1, title: 'Tee' }] }), {
        status: 200,
        headers: {
          link: '<https://mystore.myshopify.com/admin/api/2024-10/products.json?page_info=abc>; rel="next"',
        },
      });
    };

    const client = new ShopifyClient(
      { shopDomain: 'mystore.myshopify.com', accessToken: 'shpat_a', apiSecret: 'shpss_b' },
      { fetchImpl },
    );
    const page = await client.listProducts({ updatedAtMin: '2026-01-01T00:00:00Z' });
    expect(page.items).toHaveLength(1);
    expect(page.nextPageInfo).toBe('abc');
    expect(calls[0]).toContain('/admin/api/2024-10/products.json');
    expect(calls[0]).toContain('updated_at_min=2026-01-01T00%3A00%3A00Z');
  });

  it('maps 401 to an auth error on test()', async () => {
    const fetchImpl: typeof fetch = async () => new Response('denied', { status: 401 });
    const client = new ShopifyClient(
      { shopDomain: 'mystore.myshopify.com', accessToken: 'shpat_a', apiSecret: 'shpss_b' },
      { fetchImpl },
    );
    const result = await client.test();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/rejected/i);
  });

  it('does not invoke fetch with the client as this (Cloudflare Workers Illegal invocation)', async () => {
    function workersFetch(this: unknown) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError(
          'Illegal invocation: function called with incorrect `this` reference.',
        );
      }
      return new Response(JSON.stringify({ products: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const client = new ShopifyClient(
      { shopDomain: 'mystore.myshopify.com', accessToken: 'shpat_a', apiSecret: 'shpss_b' },
      { fetchImpl: workersFetch as typeof fetch },
    );
    await expect(client.listProducts()).resolves.toMatchObject({ items: [] });
  });

  it('creates a product and looks one up by SKU via GraphQL', async () => {
    const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      const body = init?.body ? String(init.body) : undefined;
      calls.push({ url, method, body });
      if (url.includes('graphql.json')) {
        return new Response(
          JSON.stringify({
            data: {
              products: {
                edges: [{ node: { id: 'gid://shopify/Product/12', handle: 'helmet', onlineStoreUrl: null } }],
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ product: { id: 99, handle: 'helmet' } }), { status: 201 });
    };

    const client = new ShopifyClient(
      { shopDomain: 'mystore.myshopify.com', accessToken: 'shpat_a', apiSecret: 'shpss_b' },
      { fetchImpl },
    );

    const created = await client.createProduct({ name: 'Helmet', price: '19.00', status: 'active', sku: 'WH-1' });
    expect(created).toEqual({ id: '99', url: 'https://mystore.myshopify.com/products/helmet' });
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({
      product: {
        title: 'Helmet',
        status: 'active',
        variants: [{ price: '19.00', sku: 'WH-1' }],
      },
    });

    await client.createProduct({ name: 'Gloves', price: '9.00', status: 'inactive' });
    expect(JSON.parse(calls[1]?.body ?? '{}')).toMatchObject({
      product: { title: 'Gloves', status: 'archived', variants: [{ price: '9.00' }] },
    });

    const found = await client.findProductBySku('WH-1');
    expect(found).toEqual({ id: '12', url: 'https://mystore.myshopify.com/products/helmet' });
    expect(calls[2]?.url).toContain('/admin/api/2024-10/graphql.json');
    expect(await client.findProductBySku('')).toBeNull();
  });

  it('probes hasUpdatesSince with limit=1 and updated_at_min', async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ products: [] }), { status: 200 });
    };
    const client = new ShopifyClient(
      { shopDomain: 'mystore.myshopify.com', accessToken: 'shpat_a', apiSecret: 'shpss_b' },
      { fetchImpl },
    );
    expect(await client.hasUpdatesSince('products', '2026-01-01T00:00:00Z')).toBe(false);
    expect(urls[0]).toContain('limit=1');
    expect(urls[0]).toContain('updated_at_min=2026-01-01T00%3A00%3A00Z');
  });

  it('reads countResource from the Admin count endpoint', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ count: 12 }), { status: 200 });
    const client = new ShopifyClient(
      { shopDomain: 'mystore.myshopify.com', accessToken: 'shpat_a', apiSecret: 'shpss_b' },
      { fetchImpl },
    );
    expect(await client.countResource('orders')).toBe(12);
  });
});
