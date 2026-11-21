/**
 * WeldCommerce entity events.
 *
 * `order` includes `placed` as a derived subscription action that agents
 * can listen to (mapped from order:created inside agent-dispatch).
 */
export const COMMERCE_ENTITY_EVENTS = {
  order: ['created', 'updated', 'deleted', 'placed', 'cancelled', 'completed', 'paid', 'refunded'],
  commerce_order: ['created', 'updated', 'deleted', 'placed', 'cancelled', 'completed'],
  product: ['created', 'updated', 'deleted', 'archived'],
  category: ['created', 'updated', 'deleted'],
  commerce_customer: ['created', 'updated', 'deleted'],
  discount: ['created', 'updated', 'deleted'],
  commerce_settings: ['updated'],
  // Sales channels (phase 4). A key event never carries the secret.
  commerce_channel: ['created', 'updated', 'deleted'],
  commerce_channel_key: ['created', 'revoked', 'rotated'],
  commerce_shipping_rate: ['created', 'updated', 'deleted'],
  // The workspace's Mollie connection (phase 5). Never carries a token or key.
  commerce_payment_connection: ['connected', 'updated', 'disconnected'],
  website: ['created', 'updated', 'deleted', 'archived'],
  website_domain: ['created', 'updated', 'deleted'],
  website_page: ['created', 'updated', 'deleted', 'archived'],
  website_section: ['created', 'updated', 'deleted'],
  // Cart + fulfillment (returns / shipping)
  cart: ['created', 'updated', 'deleted'],
  return: ['created', 'updated', 'deleted', 'approved', 'rejected', 'completed'],
  return_reason: ['created', 'updated', 'deleted'],
  return_rule: ['created', 'updated', 'deleted'],
  shipment: ['created', 'updated', 'deleted', 'shipped', 'delivered'],
  shipping_price: ['created', 'updated', 'deleted'],
  shipping_rule: ['created', 'updated', 'deleted'],
} as const;
