import { describe, it, expect } from 'vitest';
import {
  buildWooCommerceAuthUrl,
  isAllowedConnectorReturnUrl,
  parseWooCommerceAuthCallback,
  woocommerceAuthCallbackUrl,
  woocommerceAuthKvKey,
} from './auth';

describe('WooCommerce application authentication', () => {
  it('builds an encoded /wc-auth/v1/authorize URL', () => {
    const url = buildWooCommerceAuthUrl({
      storeUrl: 'https://shop.example/',
      userId: 'wooa_abc',
      returnUrl: 'https://app.weldsuite.org/settings/integrations/woocommerce',
      callbackUrl: 'https://integration-webhooks.weldsuite.org/webhooks/woocommerce/auth',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://shop.example/wc-auth/v1/authorize');
    expect(parsed.searchParams.get('app_name')).toBe('WeldSuite');
    expect(parsed.searchParams.get('scope')).toBe('read_write');
    expect(parsed.searchParams.get('user_id')).toBe('wooa_abc');
    expect(parsed.searchParams.get('return_url')).toBe(
      'https://app.weldsuite.org/settings/integrations/woocommerce',
    );
    expect(parsed.searchParams.get('callback_url')).toContain('/webhooks/woocommerce/auth');
  });

  it('parses the JSON keys WooCommerce POSTs to callback_url', () => {
    const parsed = parseWooCommerceAuthCallback(
      JSON.stringify({
        key_id: 12,
        user_id: 'wooa_abc',
        consumer_key: 'ck_aaa',
        consumer_secret: 'cs_bbb',
        key_permissions: 'read_write',
      }),
    );
    expect(parsed).toEqual({
      keyId: 12,
      userId: 'wooa_abc',
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
      isAllowedConnectorReturnUrl('https://preview.weldsuite.pages.dev/settings/integrations/woocommerce'),
    ).toBe(true);
    expect(isAllowedConnectorReturnUrl('https://evil.example/settings/integrations/woocommerce')).toBe(false);
    expect(isAllowedConnectorReturnUrl('https://app.weldsuite.org/settings/billing')).toBe(false);
  });

  it('builds the HTTPS callback path and KV key', () => {
    expect(woocommerceAuthCallbackUrl('https://integration-webhooks.weldsuite.org/')).toBe(
      'https://integration-webhooks.weldsuite.org/webhooks/woocommerce/auth',
    );
    expect(woocommerceAuthKvKey('wooa_1')).toBe('wooauth:wooa_1');
  });
});
