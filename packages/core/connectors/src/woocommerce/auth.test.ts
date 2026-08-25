import { describe, it, expect } from 'vitest';
import {
  buildWooCommerceAuthUrl,
  isAllowedConnectorReturnUrl,
  parseWooCommerceAuthCallback,
  resolveWooCommerceAuthCallbackUrl,
  signWooCommerceAuthUserId,
  verifyWooCommerceAuthUserId,
  woocommerceAuthCallbackUrl,
} from './auth';

describe('WooCommerce application authentication', () => {
  it('builds an encoded /wc-auth/v1/authorize URL', () => {
    const url = buildWooCommerceAuthUrl({
      storeUrl: 'https://shop.example/',
      userId: 'wooa.abc.def',
      returnUrl: 'https://app.weldsuite.org/settings/integrations/woocommerce',
      callbackUrl: 'https://app-api.weldsuite.org/webhooks/woocommerce/auth',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://shop.example/wc-auth/v1/authorize');
    expect(parsed.searchParams.get('app_name')).toBe('WeldSuite');
    expect(parsed.searchParams.get('scope')).toBe('read_write');
    expect(parsed.searchParams.get('user_id')).toBe('wooa.abc.def');
    expect(parsed.searchParams.get('return_url')).toBe(
      'https://app.weldsuite.org/settings/integrations/woocommerce',
    );
    expect(parsed.searchParams.get('callback_url')).toBe(
      'https://app-api.weldsuite.org/webhooks/woocommerce/auth',
    );
  });

  it('parses the JSON keys WooCommerce POSTs to callback_url', () => {
    const parsed = parseWooCommerceAuthCallback(
      JSON.stringify({
        key_id: 12,
        user_id: 'wooa.abc.def',
        consumer_key: 'ck_aaa',
        consumer_secret: 'cs_bbb',
        key_permissions: 'read_write',
      }),
    );
    expect(parsed).toEqual({
      keyId: 12,
      userId: 'wooa.abc.def',
      consumerKey: 'ck_aaa',
      consumerSecret: 'cs_bbb',
      keyPermissions: 'read_write',
    });
    expect(parseWooCommerceAuthCallback('not-json')).toBeNull();
    expect(parseWooCommerceAuthCallback('{"user_id":"x"}')).toBeNull();
    expect(
      parseWooCommerceAuthCallback(
        JSON.stringify({ user_id: 99, consumer_key: 'ck_a', consumer_secret: 'cs_b' }),
      )?.userId,
    ).toBe('99');
  });

  it('allows WeldSuite return URLs and rejects open redirects', () => {
    expect(
      isAllowedConnectorReturnUrl('https://app.weldsuite.org/settings/integrations/woocommerce'),
    ).toBe(true);
    expect(isAllowedConnectorReturnUrl('http://localhost:3000/weldconnect/connectors')).toBe(true);
    expect(
      isAllowedConnectorReturnUrl('https://app.weldsuite.org/settings/integrations/moneybird'),
    ).toBe(true);
    expect(
      isAllowedConnectorReturnUrl('https://preview.weldsuite.pages.dev/settings/integrations/woocommerce'),
    ).toBe(true);
    expect(isAllowedConnectorReturnUrl('https://evil.example/settings/integrations/woocommerce')).toBe(false);
    expect(isAllowedConnectorReturnUrl('https://app.weldsuite.org/settings/billing')).toBe(false);
  });

  it('resolves the HTTPS callback onto app-api, not the webhook worker', () => {
    expect(woocommerceAuthCallbackUrl('https://app-api.weldsuite.org/')).toBe(
      'https://app-api.weldsuite.org/webhooks/woocommerce/auth',
    );
    expect(
      resolveWooCommerceAuthCallbackUrl({
        requestOrigin: 'https://app-api-abc.workers.dev',
        environment: 'test',
      }),
    ).toBe('https://app-api-abc.workers.dev/webhooks/woocommerce/auth');
    expect(resolveWooCommerceAuthCallbackUrl({ environment: 'test' })).toBe(
      'https://app-api-test.weldsuite.org/webhooks/woocommerce/auth',
    );
    expect(resolveWooCommerceAuthCallbackUrl({ requestOrigin: 'http://localhost:8789' })).toBeNull();
    expect(resolveWooCommerceAuthCallbackUrl({ environment: 'development' })).toBeNull();
  });

  it('signs and verifies the opaque user_id WooCommerce echoes back', async () => {
    const secret = 'test-secret';
    const token = await signWooCommerceAuthUserId(
      { clerkOrgId: 'org_1', connectionId: 'conn_1', connectedBy: 'user_1' },
      secret,
      1_700_000_000,
    );
    expect(token.startsWith('wooa.')).toBe(true);
    await expect(verifyWooCommerceAuthUserId(token, secret, 1_700_000_000)).resolves.toEqual({
      clerkOrgId: 'org_1',
      connectionId: 'conn_1',
      connectedBy: 'user_1',
      exp: 1_700_000_000 + 15 * 60,
    });
    await expect(verifyWooCommerceAuthUserId(token, 'other', 1_700_000_000)).resolves.toBeNull();
    await expect(verifyWooCommerceAuthUserId(token, secret, 1_700_000_000 + 16 * 60)).resolves.toBeNull();
    await expect(verifyWooCommerceAuthUserId('wooa.tampered.sig', secret)).resolves.toBeNull();
  });
});
