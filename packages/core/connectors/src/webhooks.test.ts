import { describe, it, expect } from 'vitest';
import {
  connectorWebhookDeliveryUrl,
  hmacSha256Base64,
  hmacSha256Hex,
  matchWebhookTopic,
  timingSafeEqual,
  unwrapWebhookPayload,
  verifyMoneybirdWebhook,
  verifyShopifyWebhook,
  verifyWooCommerceWebhook,
  webhookTopicsFor,
} from './webhooks';

describe('connector webhooks', () => {
  it('maps Woo and Shopify topics onto setting keys', () => {
    expect(matchWebhookTopic('woocommerce', 'product.updated')?.settingKey).toBe('products');
    expect(matchWebhookTopic('shopify', 'orders/delete')?.kind).toBe('delete');
    expect(webhookTopicsFor('woocommerce')).toHaveLength(9);
    expect(matchWebhookTopic('moneybird', 'sales_invoice_state_changed_to_paid')?.syncName).toBe(
      'moneybird-sales-invoices',
    );
    expect(matchWebhookTopic('moneybird', 'receipt_destroyed')?.kind).toBe('delete');
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

  it('verifies a Moneybird t=,v1= HMAC hex signature and rejects stale timestamps', async () => {
    const body = '{"action":"contact_updated","entity":{"id":"1"}}';
    const secret = 'mb_webhook_secret';
    const timestamp = '1700000000';
    const digest = await hmacSha256Hex(secret, `${timestamp}.${body}`);
    const signature = `t=${timestamp},v1=${digest}`;
    expect(await verifyMoneybirdWebhook({ secret, body, signature, nowSeconds: 1700000100 })).toBe(true);
    expect(await verifyMoneybirdWebhook({ secret, body, signature, nowSeconds: 1700000401 })).toBe(false);
    expect(unwrapWebhookPayload('moneybird', { action: 'contact_updated', entity: { id: '1', email: 'a@b.c' } })).toEqual({
      id: '1',
      email: 'a@b.c',
    });
  });
});
