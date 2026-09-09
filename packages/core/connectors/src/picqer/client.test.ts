import { describe, it, expect } from 'vitest';
import { ConnectorApiError } from '../types';
import {
  expandPicqerProductStock,
  normalizePicqerSubdomain,
  PicqerClient,
  PICQER_USER_AGENT,
} from './client';

describe('normalizePicqerSubdomain', () => {
  it('accepts a bare subdomain and a full host', () => {
    expect(normalizePicqerSubdomain('acme')).toBe('acme');
    expect(normalizePicqerSubdomain('https://acme.picqer.com/')).toBe('acme');
  });

  it('rejects an empty subdomain', () => {
    expect(() => normalizePicqerSubdomain('')).toThrow(ConnectorApiError);
  });
});

describe('expandPicqerProductStock', () => {
  it('expands stock rows into inventory records', () => {
    const rows = expandPicqerProductStock({
      idproduct: 12,
      productcode: 'SKU-1',
      name: 'Widget',
      stock: [
        { idwarehouse: 1, stock: 10, freestock: 8, reserved: 2 },
        { idwarehouse: 2, stock: 3, freestock: 3, reserved: 0 },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: '12:1', idproduct: 12, freestock: 8 });
    expect(rows[1]).toMatchObject({ id: '12:2', idwarehouse: 2 });
  });
});

describe('PicqerClient', () => {
  it('sends Basic auth, User-Agent, and offset pagination', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify([{ idproduct: 1, name: 'Tee', productcode: 'T1' }]), {
        status: 200,
      });
    };

    const client = new PicqerClient(
      { subdomain: 'acme', apiKey: 'key_abc' },
      { fetchImpl },
    );
    const page = await client.listProducts({ offset: 0, updatedAfter: '2026-01-01 00:00:00' });
    expect(page.items).toHaveLength(1);
    expect(calls[0]?.url).toContain('https://acme.picqer.com/api/v1/products');
    expect(calls[0]?.url).toContain('offset=0');
    expect(calls[0]?.headers.get('User-Agent')).toBe(PICQER_USER_AGENT);
    expect(calls[0]?.headers.get('Authorization')).toMatch(/^Basic /);
  });

  it('maps 401 to an auth error on test()', async () => {
    const fetchImpl: typeof fetch = async () => new Response('denied', { status: 401 });
    const client = new PicqerClient({ subdomain: 'acme', apiKey: 'bad' }, { fetchImpl });
    const result = await client.test();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/rejected/i);
  });

  it('retries on 429 with backoff hint', async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async () => {
      attempts++;
      if (attempts === 1) {
        return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };
    const client = new PicqerClient({ subdomain: 'acme', apiKey: 'key' }, { fetchImpl });
    await expect(client.listProducts()).resolves.toMatchObject({ items: [] });
    expect(attempts).toBe(2);
  });

  it('registers webhooks with secret and deletes by id', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET');
      const body = init?.body ? String(init.body) : undefined;
      calls.push({ url, method, body });
      if (method === 'POST') {
        return new Response(JSON.stringify({ idhook: 55, event: 'orders.created' }), { status: 201 });
      }
      return new Response(null, { status: 204 });
    };
    const client = new PicqerClient({ subdomain: 'acme', apiKey: 'key' }, { fetchImpl });
    const created = await client.registerWebhooks({
      deliveryUrl: 'https://integration-webhooks.weldsuite.org/webhooks/connectors/c1',
      secret: 'whsec',
      topics: [
        {
          provider: 'picqer',
          topic: 'orders.created',
          settingKey: 'orders',
          kind: 'create',
        },
      ],
    });
    expect(created[0]).toMatchObject({ id: '55', topic: 'orders.created' });
    expect(calls[0]?.body).toContain('"secret":"whsec"');
    await client.deleteWebhook('55');
    expect(calls[1]?.method).toBe('DELETE');
  });

  it('creates a product and finds one by SKU', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('productcode=')) {
        return new Response(JSON.stringify([{ idproduct: 9, productcode: 'HELMET' }]), { status: 200 });
      }
      if (String(init?.method) === 'POST') {
        return new Response(JSON.stringify({ idproduct: 99 }), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const client = new PicqerClient({ subdomain: 'acme', apiKey: 'key' }, { fetchImpl });
    const created = await client.createProduct({ name: 'Helmet', price: '19.00', status: 'active', sku: 'HELMET' });
    expect(created.id).toBe('99');
    const found = await client.findProductBySku('HELMET');
    expect(found?.id).toBe('9');
  });

  it('does not invoke fetch with the client as this', async () => {
    function workersFetch(this: unknown) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }
    const client = new PicqerClient(
      { subdomain: 'acme', apiKey: 'key' },
      { fetchImpl: workersFetch as unknown as typeof fetch },
    );
    await expect(client.listProducts()).resolves.toMatchObject({ items: [] });
  });
});
