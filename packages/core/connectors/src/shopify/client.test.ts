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
});
