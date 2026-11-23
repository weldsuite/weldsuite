import { createStorefrontClient } from '@weldsuite/commerce-sdk';
import { describe, expect, it } from 'vitest';
import { HOSTED_KEY, hostedFetch } from './hosted-fetch';

function recorder() {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers) });
    return new Response(JSON.stringify({ data: { sent: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch };
}

describe('hosted fetch', () => {
  it('swaps the SDK’s placeholder key for the renderer secret and names the shop host', async () => {
    const { calls, fetch } = recorder();
    const client = createStorefrontClient({ baseUrl: 'http://api.test', key: HOSTED_KEY, fetch: hostedFetch('s3cret', 'shop.example.com', fetch) });
    await client.auth.requestCode('ann@example.com', { shopperIp: '203.0.113.9' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('http://api.test/storefront/v1/auth/code');
    expect(call?.headers.get('authorization')).toBe('Hosted s3cret');
    expect(call?.headers.get('x-storefront-host')).toBe('shop.example.com');
    // What the SDK sets itself goes through untouched.
    expect(call?.headers.get('x-shopper-ip')).toBe('203.0.113.9');
    expect(call?.headers.get('content-type')).toBe('application/json');
  });

  it('keeps cart and shopper tokens', async () => {
    const { calls, fetch } = recorder();
    const client = createStorefrontClient({ baseUrl: 'http://api.test', key: HOSTED_KEY, fetch: hostedFetch('s3cret', 'a.shop.localhost', fetch) });
    await client.cart.get('wct_cart', { shopperToken: 'wss_session' });
    expect(calls[0]?.headers.get('x-cart-token')).toBe('wct_cart');
    expect(calls[0]?.headers.get('x-shopper-token')).toBe('wss_session');
    expect(calls[0]?.headers.get('authorization')).toBe('Hosted s3cret');
  });

  it('never runs without a secret', () => {
    expect(() => hostedFetch('', 'shop.example.com')).toThrow();
  });
});
