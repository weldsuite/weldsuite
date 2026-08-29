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

describe('Moneybird mappers', () => {
  it('maps a company contact onto a wrapping party', () => {
    const mapped = mapConnectorRecord(
      'party',
      {
        id: 'c1',
        company_name: 'Acme BV',
        email: 'info@acme.test',
        tax_number: 'NL123',
        sepa_iban: 'NL00TEST',
        address1: 'Kerkstraat 1',
        city: 'Amsterdam',
        zipcode: '1012AB',
        country: 'NL',
      },
      'moneybird',
    );
    expect(mapped?.entity).toBe('party');
    if (mapped?.entity !== 'party') return;
    expect(mapped.kind).toBe('company');
    expect(mapped.identity).toMatchObject({ name: 'Acme BV', vatNumber: 'NL123', email: 'info@acme.test' });
    expect(mapped.values).toMatchObject({ displayName: 'Acme BV', iban: 'NL00TEST', role: 'none' });
  });

  it('maps a sales invoice without a journal id and with nested contact', () => {
    const mapped = mapConnectorRecord('invoice', {
      id: 'inv1',
      invoice_id: '2024-0001',
      state: 'open',
      contact_id: 'c1',
      contact: { id: 'c1', company_name: 'Acme BV', email: 'info@acme.test' },
      invoice_date: '2024-01-15',
      due_date: '2024-01-29',
      currency: 'EUR',
      total_price_excl_tax: '100.0',
      total_price_incl_tax: '121.0',
      total_tax: '21.0',
      details: [{ description: 'Hours', amount: '2 x', price: '50.0', product_id: 'p1' }],
    });
    expect(mapped?.entity).toBe('invoice');
    if (mapped?.entity !== 'invoice') return;
    expect(mapped.values).toMatchObject({
      invoiceNumber: '2024-0001',
      status: 'sent',
    });
    expect(mapped.values.journalEntryId).toBeUndefined();
    expect(mapped.contactExternalId).toBe('c1');
    expect(mapped.lineItems).toHaveLength(1);
    expect(mapped.lineItems[0]?.quantity).toBe('2');
  });

  it('maps a late purchase invoice onto an overdue bill', () => {
    const mapped = mapConnectorRecord('bill', {
      id: 'bil1',
      reference: 'PIN-9',
      state: 'late',
      contact_id: 'c2',
      date: '2024-02-01',
      due_date: '2024-02-15',
      total_price_excl_tax: '10',
      total_price_incl_tax: '12.10',
    });
    expect(mapped?.entity).toBe('bill');
    if (mapped?.entity !== 'bill') return;
    expect(mapped.values).toMatchObject({ billNumber: 'PIN-9', status: 'overdue' });
    expect(mapped.values.journalEntryId).toBeUndefined();
  });

  it('maps a Moneybird product from title and identifier', () => {
    const mapped = mapConnectorRecord(
      'product',
      { id: 'p1', title: 'Consulting', identifier: 'CONS-1', price: '90.00' },
      'moneybird',
    );
    expect(mapped?.values).toMatchObject({ name: 'Consulting', sku: 'CONS-1', price: '90.00' });
  });

  it('maps a financial account onto a bank account', () => {
    const mapped = mapConnectorRecord('bank_account', {
      id: 'fa1',
      name: 'Rabo Checking',
      identifier: 'NL91ABNA0417164300',
      currency: 'EUR',
      type: 'bank_account',
      provider: 'rabobank',
      active: true,
    });
    expect(mapped?.entity).toBe('bank_account');
    if (mapped?.entity !== 'bank_account') return;
    expect(mapped.values).toMatchObject({
      name: 'Rabo Checking',
      iban: 'NL91ABNA0417164300',
      currency: 'EUR',
      isActive: true,
    });
  });

  it('maps a financial mutation onto a bank transaction', () => {
    const mapped = mapConnectorRecord('bank_transaction', {
      id: 'fm1',
      financial_account_id: 'fa1',
      amount: '-42.50',
      date: '2026-03-01',
      message: 'Invoice payment',
      contra_account_name: 'Acme',
      contra_account_number: 'NL00TEST0123456789',
      state: 'unprocessed',
    });
    expect(mapped?.entity).toBe('bank_transaction');
    if (mapped?.entity !== 'bank_transaction') return;
    expect(mapped.financialAccountExternalId).toBe('fa1');
    expect(mapped.values).toMatchObject({
      amount: '-42.50',
      description: 'Invoice payment',
      counterpartyName: 'Acme',
      status: 'unreconciled',
      externalId: 'fm1',
    });
  });
});
