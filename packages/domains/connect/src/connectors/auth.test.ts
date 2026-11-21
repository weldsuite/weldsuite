import { describe, it, expect } from 'vitest';
import { completeWooCommerceAppAuth, startMoneybirdOAuth, startWooCommerceAppAuth } from './auth';
import { startStripeOAuth } from './stripe-auth';

// The EU edition's platform: not one of Global's hosts, so only its own
// PUBLIC_APP_URL makes it a WeldSuite page.
const EU_PAGE = 'https://app.test.weldsuite.eu/settings/integrations/moneybird';
const EU_ENV = { PUBLIC_APP_URL: 'https://app.test.weldsuite.eu' };
const START = { clerkOrgId: 'org_1', userId: 'user_1', enabledSyncs: [], returnUrl: EU_PAGE };

describe("OAuth starts on the install's own platform origin", () => {
  it('refuses the EU page when PUBLIC_APP_URL names another origin', async () => {
    const env = { PUBLIC_APP_URL: 'https://app.weldsuite.org' } as never;
    expect(await startMoneybirdOAuth({ ...START, env })).toEqual({
      error: 'Return URL is not a WeldSuite page',
      status: 400,
    });
    expect(await startStripeOAuth({ ...START, env })).toEqual({
      error: 'Return URL is not a WeldSuite page',
      status: 400,
    });
  });

  it('lets Moneybird past the return-URL check on PUBLIC_APP_URL', async () => {
    const result = await startMoneybirdOAuth({ ...START, env: EU_ENV as never });
    expect(result).toMatchObject({ status: 400 });
    expect('error' in result && result.error).toMatch(/Moneybird connect is not configured/);
  });

  it('lets Stripe past the return-URL check on PUBLIC_APP_URL', async () => {
    const result = await startStripeOAuth({ ...START, env: EU_ENV as never });
    expect(result).toMatchObject({ status: 400 });
    expect('error' in result && result.error).toMatch(/Stripe connect is not configured/);
  });
});

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
