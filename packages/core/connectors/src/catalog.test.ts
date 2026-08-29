import { describe, it, expect } from 'vitest';
import {
  CONNECTORS,
  connectorIntervalMinutes,
  connectorSyncMode,
  connectorSyncNames,
  DEFAULT_ENABLED_SYNCS,
  defaultEnabledSyncs,
  enabledConnectorSyncs,
  getConnector,
  getConnectorSync,
  listConnectors,
} from './catalog';

describe('connector catalog', () => {
  it('ships WooCommerce, Shopify, and Moneybird as first-party connectors', () => {
    expect(listConnectors().map((c) => c.provider)).toEqual(['woocommerce', 'shopify', 'moneybird']);
  });

  it('keeps provider keys unique', () => {
    const keys = CONNECTORS.map((c) => c.provider);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps external entity types unique per connector so mappings never collide', () => {
    for (const connector of CONNECTORS) {
      const types = connector.syncs.map((s) => s.externalEntityType);
      expect(new Set(types).size).toBe(types.length);
    }
  });

  it('exposes credential fields the UI can render as a connect form', () => {
    const woo = getConnector('woocommerce');
    expect(woo?.auth.kind).toBe('app_auth');
    expect(woo?.auth.fields.map((f) => f.key)).toEqual(['storeUrl']);
    const shopify = getConnector('shopify');
    expect(shopify?.auth.kind).toBe('api_key');
    expect(shopify?.auth.fields.map((f) => f.key)).toEqual(['shopDomain', 'accessToken', 'apiSecret']);
  });

  it('resolves a sync from the (provider, syncName) pair', () => {
    const resolved = getConnectorSync('woocommerce', 'woocommerce-products');
    expect(resolved?.sync.internalEntity).toBe('product');
    expect(resolved?.sync.settingKey).toBe('products');
    expect(getConnectorSync('shopify', 'shopify-orders')?.sync.internalEntity).toBe('order');
  });

  it('returns undefined for unknown integrations and syncs', () => {
    expect(getConnectorSync('magento', 'magento-products')).toBeUndefined();
    expect(getConnectorSync('woocommerce', 'woocommerce-coupons')).toBeUndefined();
    expect(getConnector('magento')).toBeUndefined();
  });

  it('filters enabled syncs by setting key or sync name', () => {
    const woo = getConnector('woocommerce')!;
    expect(enabledConnectorSyncs(woo, ['orders']).map((s) => s.syncName)).toEqual(['woocommerce-orders']);
    expect(enabledConnectorSyncs(woo, ['woocommerce-products']).map((s) => s.settingKey)).toEqual(['products']);
    expect(enabledConnectorSyncs(woo, null).length).toBe(3);
  });

  it('lists every sync name for a manual sync-now', () => {
    expect(connectorSyncNames('woocommerce')).toEqual([
      'woocommerce-products',
      'woocommerce-orders',
      'woocommerce-customers',
    ]);
    expect(connectorSyncNames('shopify')).toEqual([
      'shopify-products',
      'shopify-orders',
      'shopify-customers',
    ]);
    expect(connectorSyncNames('unknown')).toEqual([]);
  });

  it('defaults every catalog sync on', () => {
    expect(DEFAULT_ENABLED_SYNCS).toEqual(['products', 'orders', 'customers']);
    expect(defaultEnabledSyncs('woocommerce')).toEqual(['products', 'orders', 'customers']);
    expect(defaultEnabledSyncs('moneybird')).toEqual([
      'contacts',
      'invoices',
      'products',
      'bills',
      'bankAccounts',
      'bankTransactions',
    ]);
  });

  it('lists Moneybird as a hybrid accounting connector with OAuth', () => {
    const moneybird = getConnector('moneybird');
    expect(moneybird?.category).toBe('accounting');
    expect(moneybird?.delivery).toBe('hybrid');
    expect(moneybird?.auth.kind).toBe('oauth2');
    expect(moneybird?.auth.scopes).toContain('bank');
    expect(connectorSyncMode('moneybird')).toBe('webhook_catchup');
    expect(moneybird?.syncs.map((s) => s.externalEntityType)).toEqual([
      'moneybird_contact',
      'moneybird_sales_invoice',
      'moneybird_product',
      'moneybird_purchase_invoice',
      'moneybird_receipt',
      'moneybird_financial_account',
      'moneybird_financial_mutation',
    ]);
  });

  it('marks WooCommerce and Shopify as hybrid (webhooks plus catch-up)', () => {
    expect(getConnector('woocommerce')?.delivery).toBe('hybrid');
    expect(getConnector('shopify')?.delivery).toBe('hybrid');
    expect(connectorSyncMode('woocommerce')).toBe('webhook_catchup');
    expect(connectorIntervalMinutes('woocommerce')).toBe(6 * 60);
    expect(connectorIntervalMinutes('unknown-poller')).toBe(15);
  });
});
