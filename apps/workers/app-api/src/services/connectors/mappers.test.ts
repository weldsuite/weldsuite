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

  it('maps a private WooCommerce product as inactive', () => {
    const mapped = mapConnectorRecord('product', {
      id: 13,
      name: 'Hidden visor',
      slug: 'hidden-visor',
      sku: 'HV-1',
      price: '20.00',
      status: 'private',
    });
    expect(mapped?.values).toMatchObject({ status: 'inactive', price: '20.00' });
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

describe('Shopify mappers', () => {
  it('maps a product from title/handle/variants', () => {
    const mapped = mapConnectorRecord(
      'product',
      {
        id: 101,
        title: 'Weld helmet',
        handle: 'weld-helmet',
        status: 'active',
        variants: [{ price: '129.00', sku: 'WH-1', compare_at_price: '149.00' }],
        images: [{ src: 'https://cdn.example/h.jpg', alt: 'Helmet' }],
      },
      'shopify',
    );
    expect(mapped?.entity).toBe('product');
    expect(mapped?.values).toMatchObject({
      name: 'Weld helmet',
      slug: 'weld-helmet',
      sku: 'WH-1',
      price: '129.00',
      status: 'active',
    });
  });

  it('maps an order and stamps source=shopify on the customer', () => {
    const order = mapConnectorRecord(
      'order',
      {
        id: 88,
        name: '#1001',
        financial_status: 'paid',
        currency: 'EUR',
        total_price: '50.00',
        customer: { id: 3, email: 'ada@example.com' },
        line_items: [{ title: 'Helmet', product_id: 12, quantity: 1, price: '50' }],
      },
      'shopify',
    );
    expect(order?.entity).toBe('order');
    if (order?.entity !== 'order') return;
    expect(order.customerExternalId).toBe('3');

    const person = mapConnectorRecord(
      'person',
      { id: 4, email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' },
      'shopify',
    );
    expect(person?.values).toMatchObject({ displayName: 'Ada Lovelace', source: 'shopify' });
  });

  it('treats a delete webhook stub as deleted', () => {
    expect(isDeletedRecord({ id: 1 }, true)).toBe(true);
    expect(isDeletedRecord({ id: 1, status: 'active' })).toBe(false);
  });
});
