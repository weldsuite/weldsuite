/**
 * Catalog entity types intentionally absent from `platformSyncMap`.
 *
 * Phase 9 DoD: catalog − these omits ⊆ sync-map keys. Every omit needs a
 * one-line reason. Live hub sync must not invent a second bus for these —
 * they use ChatRoom / personal topics / imperative fetches by design.
 *
 * WeldPass secrets are not on the entity-events catalog at all (EXEMPT from
 * the bus) — there is nothing to omit here.
 */

export const PLATFORM_SYNC_MAP_INTENTIONAL_OMITS = {
  chat_channel:
    'WeldChat messages/membership live on ChatRoom DO, not WorkspaceHub entity topics',
  chat_message:
    'WeldChat messages live on ChatRoom DO; hub entity sync is not required',
  chat_call:
    'WeldChat calls use the chat room path, not hub entity invalidation',
  mail_subscription:
    'Unsubscribe telemetry only — no platform list/detail query cache',
  desk_attachment:
    'Agent upload before it is sent: no query cache; the reply lands as desk_message, which syncs',
  project_pipeline_stage:
    'WeldFlow kanban stage page fetches imperatively (no useQuery); CRM pipeline_stage covers CRM',
  // WeldCommerce and shipping were removed from the platform: no screen keeps
  // a query cache for these catalog types any more.
  order: 'WeldCommerce removed: no platform orders list or detail cache',
  commerce_order: 'WeldCommerce removed: no platform orders list or detail cache',
  category: 'WeldCommerce removed: no platform product categories cache',
  commerce_customer: 'WeldCommerce removed: customers are CRM companies, synced as company/person',
  discount: 'WeldCommerce removed: no platform discounts cache',
  website: 'WeldCommerce removed: no platform websites cache',
  website_domain: 'WeldCommerce removed: no platform website domains cache',
  website_page: 'WeldCommerce removed: no platform website pages cache',
  website_section: 'WeldCommerce removed: no platform website sections cache',
  cart: 'WeldCommerce removed: no platform carts cache',
  return: 'WeldCommerce removed: no platform returns cache',
  return_reason: 'WeldCommerce removed: no platform return reasons cache',
  return_rule: 'WeldCommerce removed: no platform return rules cache',
  shipment: 'Shipping removed: a shipped pick list syncs through picklist',
  shipping_price: 'Shipping removed: no platform shipping prices cache',
  shipping_rule: 'Shipping removed: no platform shipping rules cache',
  notification_template: 'Parcel notification templates: shipping removed, no platform screen lists them',
  parcel: 'Shipping removed: no platform parcels cache',
  parcel_box: 'Shipping removed: no platform parcel boxes cache',
  parcel_carrier: 'Shipping removed: no platform carriers cache',
  parcel_order: 'Shipping removed: no platform parcel orders cache',
  parcel_pickup: 'Shipping removed: no platform pickups cache',
  parcel_wallet: 'Shipping removed: no platform parcel wallet cache',
  parcel_settings: 'Shipping removed: no platform parcel settings cache',
} as const satisfies Record<string, string>;

export type PlatformSyncMapIntentionalOmit =
  keyof typeof PLATFORM_SYNC_MAP_INTENTIONAL_OMITS;

/** Bare personal catalog topics that stay user-scoped on WorkspaceHub. */
export const PLATFORM_SYNC_MAP_PERSONAL_ONLY = [
  'notification',
] as const;
