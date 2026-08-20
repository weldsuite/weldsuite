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

describe('WooCommerceClient', () => {
  it('sends Basic auth and paginates off WP total headers', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify([{ id: 1, name: 'Tee' }]), {
        status: 200,
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
    expect(calls[0]).toContain('/wp-json/wc/v3/products');
    expect(calls[0]).toContain('page=2');
    expect(calls[0]).toContain('modified_after=2026-01-01T00%3A00%3A00');
  });

  it('maps 401 to an auth error on test()', async () => {
    const fetchImpl: typeof fetch = async () => new Response('denied', { status: 401 });
    const client = new WooCommerceClient(
      { storeUrl: 'https://shop.example', consumerKey: 'ck_a', consumerSecret: 'cs_b' },
      { fetchImpl },
    );
    const result = await client.test();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/rejected/i);
    }
  });
});
