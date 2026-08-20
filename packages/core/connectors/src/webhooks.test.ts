import { describe, it, expect } from 'vitest';
import {
  connectorWebhookDeliveryUrl,
  hmacSha256Base64,
  matchWebhookTopic,
  timingSafeEqual,
  verifyShopifyWebhook,
  verifyWooCommerceWebhook,
  webhookTopicsFor,
} from './webhooks';

describe('connector webhooks', () => {
  it('maps Woo and Shopify topics onto setting keys', () => {
    expect(matchWebhookTopic('woocommerce', 'product.updated')?.settingKey).toBe('products');
    expect(matchWebhookTopic('shopify', 'orders/delete')?.kind).toBe('delete');
    expect(webhookTopicsFor('woocommerce')).toHaveLength(9);
  });

  it('builds a per-connection delivery URL', () => {
    expect(connectorWebhookDeliveryUrl('https://integration-webhooks.weldsuite.org/', 'conn_1')).toBe(
      'https://integration-webhooks.weldsuite.org/webhooks/connectors/conn_1',
    );
  });

  it('verifies a WooCommerce HMAC signature', async () => {
    const body = '{"id":12}';
    const secret = 'whsec_test';
    const signature = await hmacSha256Base64(secret, body);
    expect(await verifyWooCommerceWebhook({ secret, body, signature })).toBe(true);
    expect(await verifyWooCommerceWebhook({ secret, body, signature: 'nope' })).toBe(false);
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });

  it('verifies a Shopify HMAC signature', async () => {
    const body = '{"id":101}';
    const secret = 'shpss_test';
    const signature = await hmacSha256Base64(secret, body);
    expect(await verifyShopifyWebhook({ secret, body, signature })).toBe(true);
    expect(await verifyShopifyWebhook({ secret, body, signature: 'nope' })).toBe(false);
  });
});
