import { describe, it, expect } from 'vitest';
import {
  CONNECTORS,
  connectorSyncNames,
  DEFAULT_ENABLED_SYNCS,
  enabledConnectorSyncs,
  getConnector,
  getConnectorSync,
  listConnectors,
} from './catalog';

describe('connector catalog', () => {
  it('ships WooCommerce as the first first-party connector', () => {
    expect(listConnectors().map((c) => c.provider)).toEqual(['woocommerce']);
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
    expect(woo?.auth.fields.map((f) => f.key)).toEqual(['storeUrl', 'consumerKey', 'consumerSecret']);
  });

  it('resolves a sync from the (provider, syncName) pair', () => {
    const resolved = getConnectorSync('woocommerce', 'woocommerce-products');
    expect(resolved?.sync.internalEntity).toBe('product');
    expect(resolved?.sync.settingKey).toBe('products');
  });

  it('returns undefined for unknown integrations and syncs', () => {
    expect(getConnectorSync('shopify', 'shopify-products')).toBeUndefined();
    expect(getConnectorSync('woocommerce', 'woocommerce-coupons')).toBeUndefined();
    expect(getConnector('shopify')).toBeUndefined();
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
    expect(connectorSyncNames('unknown')).toEqual([]);
  });

  it('defaults every WooCommerce sync on', () => {
    expect(DEFAULT_ENABLED_SYNCS).toEqual(['products', 'orders', 'customers']);
  });
});
