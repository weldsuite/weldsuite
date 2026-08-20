import { describe, it, expect } from 'vitest';
import { completeWooCommerceAppAuth, startWooCommerceAppAuth } from './auth';

describe('startWooCommerceAppAuth', () => {
  it('rejects a return URL that is not a WeldSuite page', async () => {
    const result = await startWooCommerceAppAuth({
      db: {} as never,
      env: {} as never,
      clerkOrgId: 'org_1',
      userId: 'user_1',
      storeUrl: 'https://shop.example',
      enabledSyncs: ['products'],
      returnUrl: 'https://evil.example/phish',
    });
    expect(result).toEqual({ error: 'Return URL is not a WeldSuite page', status: 400 });
  });

  it('rejects a non-HTTPS callback host (local wrangler has no public URL)', async () => {
    const result = await startWooCommerceAppAuth({
      db: {} as never,
      env: { ENVIRONMENT: 'development' } as never,
      clerkOrgId: 'org_1',
      userId: 'user_1',
      storeUrl: 'https://shop.example',
      enabledSyncs: ['products'],
      returnUrl: 'https://app.weldsuite.org/settings/integrations/woocommerce',
    });
    expect(result).toMatchObject({ status: 400 });
    expect('error' in result && result.error).toMatch(/HTTPS callback/);
  });
});

describe('completeWooCommerceAppAuth', () => {
  it('rejects invalid JSON with 400', async () => {
    const result = await completeWooCommerceAppAuth({
      env: { INTERNAL_API_SECRET: 'secret' } as never,
      rawBody: 'not-json',
      waitUntil: () => undefined,
    });
    expect(result).toEqual({ ok: false, status: 400, message: 'invalid WooCommerce auth payload' });
  });

  it('rejects an unsigned user_id with 400', async () => {
    const result = await completeWooCommerceAppAuth({
      env: { INTERNAL_API_SECRET: 'secret' } as never,
      rawBody: JSON.stringify({
        user_id: 'wooa_not_signed',
        consumer_key: 'ck_aaa',
        consumer_secret: 'cs_bbb',
      }),
      waitUntil: () => undefined,
    });
    expect(result).toEqual({ ok: false, status: 400, message: 'unknown or expired WooCommerce auth' });
  });
});
