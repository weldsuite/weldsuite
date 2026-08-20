/**
 * WeldSuite connector catalog — first-party providers we have wired to
 * WeldSuite data models.
 *
 * A connector only appears here once its syncs have a mapper into a WeldSuite
 * entity, so "visible in the catalog" and "safe to connect" mean the same thing.
 *
 * Adding a connector: add an entry here, add a mapper for each `internalEntity`
 * it declares, and implement a provider client that the sync runner can call.
 */

/** WeldSuite entity a synced model lands in. */
export type ConnectorEntity = 'product' | 'order' | 'person';

export type ConnectorCategory = 'ecommerce' | 'crm' | 'accounting' | 'support' | 'productivity';

/** Toggle the tenant enables on the connection itself. */
export type ConnectorSyncSettingKey = 'products' | 'orders' | 'customers';

export type ConnectorCredentialFieldType = 'url' | 'text' | 'secret';

export interface ConnectorCredentialField {
  key: string;
  label: string;
  type: ConnectorCredentialFieldType;
  placeholder?: string;
  required?: boolean;
}

export interface ConnectorSyncDef {
  /** Stable id stored on `connector_connections.enabled_syncs`. */
  syncName: string;
  /** Provider model the sync emits. */
  model: string;
  /** WeldSuite entity the records are mapped into. */
  internalEntity: ConnectorEntity;
  /** Mapping key stored on `integration_entity_mappings.externalEntityType`. */
  externalEntityType: string;
  /** Settings toggle this sync is gated by. */
  settingKey: ConnectorSyncSettingKey;
}

export interface ConnectorDef {
  /** Stable WeldSuite id — also the `connector_connections.provider` value. */
  provider: string;
  label: string;
  description: string;
  category: ConnectorCategory;
  /** Icon key resolved to a lucide component by the platform UI. */
  icon: string;
  auth: {
    kind: 'api_key';
    fields: ConnectorCredentialField[];
  };
  syncs: ConnectorSyncDef[];
}

export const CONNECTORS: ConnectorDef[] = [
  {
    provider: 'woocommerce',
    label: 'WooCommerce',
    description: 'Sync products, orders, and customers from a WooCommerce store into WeldSuite.',
    category: 'ecommerce',
    icon: 'shopping-bag',
    auth: {
      kind: 'api_key',
      fields: [
        {
          key: 'storeUrl',
          label: 'Store URL',
          type: 'url',
          placeholder: 'https://yourstore.com',
          required: true,
        },
        {
          key: 'consumerKey',
          label: 'Consumer Key',
          type: 'secret',
          placeholder: 'ck_...',
          required: true,
        },
        {
          key: 'consumerSecret',
          label: 'Consumer Secret',
          type: 'secret',
          placeholder: 'cs_...',
          required: true,
        },
      ],
    },
    syncs: [
      {
        syncName: 'woocommerce-products',
        model: 'WooProduct',
        internalEntity: 'product',
        externalEntityType: 'woocommerce_product',
        settingKey: 'products',
      },
      {
        syncName: 'woocommerce-orders',
        model: 'WooOrder',
        internalEntity: 'order',
        externalEntityType: 'woocommerce_order',
        settingKey: 'orders',
      },
      {
        syncName: 'woocommerce-customers',
        model: 'WooCustomer',
        internalEntity: 'person',
        externalEntityType: 'woocommerce_customer',
        settingKey: 'customers',
      },
    ],
  },
  {
    provider: 'shopify',
    label: 'Shopify',
    description: 'Sync products, orders, and customers from a Shopify store into WeldSuite.',
    category: 'ecommerce',
    icon: 'store',
    auth: {
      kind: 'api_key',
      fields: [
        {
          key: 'shopDomain',
          label: 'Shop domain',
          type: 'text',
          placeholder: 'mystore.myshopify.com',
          required: true,
        },
        {
          key: 'accessToken',
          label: 'Admin API access token',
          type: 'secret',
          placeholder: 'shpat_...',
          required: true,
        },
        {
          key: 'apiSecret',
          label: 'API secret key',
          type: 'secret',
          placeholder: 'shpss_...',
          required: true,
        },
      ],
    },
    syncs: [
      {
        syncName: 'shopify-products',
        model: 'ShopifyProduct',
        internalEntity: 'product',
        externalEntityType: 'shopify_product',
        settingKey: 'products',
      },
      {
        syncName: 'shopify-orders',
        model: 'ShopifyOrder',
        internalEntity: 'order',
        externalEntityType: 'shopify_order',
        settingKey: 'orders',
      },
      {
        syncName: 'shopify-customers',
        model: 'ShopifyCustomer',
        internalEntity: 'person',
        externalEntityType: 'shopify_customer',
        settingKey: 'customers',
      },
    ],
  },
];

export function listConnectors(): ConnectorDef[] {
  return CONNECTORS;
}

export function getConnector(provider: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.provider === provider);
}

export function getConnectorSync(
  provider: string,
  syncName: string,
): { connector: ConnectorDef; sync: ConnectorSyncDef } | undefined {
  const connector = getConnector(provider);
  if (!connector) return undefined;
  const sync = connector.syncs.find((s) => s.syncName === syncName);
  if (!sync) return undefined;
  return { connector, sync };
}

/** Sync names the tenant has enabled (or every sync, when unset). */
export function enabledConnectorSyncs(
  connector: ConnectorDef,
  enabled: string[] | null | undefined,
): ConnectorSyncDef[] {
  if (!enabled || enabled.length === 0) return connector.syncs;
  const allowed = new Set(enabled);
  return connector.syncs.filter((s) => allowed.has(s.syncName) || allowed.has(s.settingKey));
}

export function connectorSyncNames(provider: string): string[] {
  return getConnector(provider)?.syncs.map((s) => s.syncName) ?? [];
}

export const DEFAULT_ENABLED_SYNCS: ConnectorSyncSettingKey[] = ['products', 'orders', 'customers'];
