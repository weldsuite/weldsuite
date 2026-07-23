/**
 * WeldCommerce entity events.
 *
 * `order` includes `placed` as a derived subscription action that agents
 * can listen to (mapped from order:created inside agent-dispatch).
 */
export const COMMERCE_ENTITY_EVENTS = {
  order: ['created', 'updated', 'deleted', 'placed', 'cancelled', 'completed'],
  commerce_order: ['created', 'updated', 'deleted', 'placed', 'cancelled', 'completed'],
  product: ['created', 'updated', 'deleted', 'archived'],
  category: ['created', 'updated', 'deleted'],
  commerce_customer: ['created', 'updated', 'deleted'],
  discount: ['created', 'updated', 'deleted'],
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
