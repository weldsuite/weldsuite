import { describe, it, expect } from 'vitest';
import { isDeletedRecord, mapConnectorRecord } from './mappers';

describe('WooCommerce product mapper', () => {
  it('maps a published product onto WeldCommerce fields', () => {
    const mapped = mapConnectorRecord('product', {
      id: 12,
      name: 'Weld helmet',
      slug: 'weld-helmet',
      sku: 'WH-1',
      price: '129.00',
      regular_price: '149.00',
      status: 'publish',
      manage_stock: true,
      images: [{ src: 'https://cdn.example/h.jpg', alt: 'Helmet' }],
    });
    expect(mapped?.entity).toBe('product');
    expect(mapped?.externalId).toBe('12');
    expect(mapped?.values).toMatchObject({
      name: 'Weld helmet',
      slug: 'weld-helmet',
      sku: 'WH-1',
      price: '129.00',
      status: 'active',
    });
  });
});

describe('WooCommerce order mapper', () => {
  it('maps totals, customer and line items', () => {
    const mapped = mapConnectorRecord('order', {
      id: 88,
      number: '88',
      status: 'completed',
      currency: 'EUR',
      total: '50.00',
      subtotal: '40.00',
      customer_id: 3,
      billing: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
      line_items: [{ name: 'Helmet', product_id: 12, quantity: 1, price: '50', total: '50' }],
    });
    expect(mapped?.entity).toBe('order');
    if (mapped?.entity !== 'order') return;
    expect(mapped.values.status).toBe('completed');
    expect(mapped.values.paymentStatus).toBe('paid');
    expect(mapped.values.customerEmail).toBe('ada@example.com');
    expect(mapped.customerExternalId).toBe('3');
    expect(mapped.lineItems).toHaveLength(1);
  });

  it('treats trash as a delete', () => {
    expect(isDeletedRecord({ id: 1, status: 'trash' })).toBe(true);
    expect(isDeletedRecord({ id: 1, status: 'completed' })).toBe(false);
  });
});

describe('WooCommerce customer mapper', () => {
  it('requires a name or email and stamps displayName', () => {
    expect(mapConnectorRecord('person', { id: 1 })).toBeNull();
    const mapped = mapConnectorRecord('person', {
      id: 4,
      email: 'ada@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
    });
    expect(mapped?.values).toMatchObject({
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      source: 'woocommerce',
    });
  });
});
