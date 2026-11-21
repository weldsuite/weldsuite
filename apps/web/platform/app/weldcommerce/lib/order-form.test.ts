import { describe, expect, it } from 'vitest';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';
import {
  buildOrderFormSchema,
  cleanAddress,
  emptyAddress,
  emptyOrderValues,
  lineIsComplete,
  toOrderInput,
  toOrderPatch,
  toQuoteRequest,
  valuesFromOrder,
  type LineValues,
} from './order-form';

const catalogLine: LineValues = {
  productId: 'prod_1',
  variantId: null,
  sku: 'SKU-1',
  name: 'Linen shirt',
  variantName: null,
  quantity: 2,
  unitPrice: '',
};
const variantLine: LineValues = { ...catalogLine, productId: 'prod_2', variantId: 'var_2', variantName: 'M / Red', unitPrice: '12.50' };
const freeLine: LineValues = { productId: null, variantId: null, sku: null, name: 'Installation', variantName: null, quantity: 1, unitPrice: '75.00' };

describe('cleanAddress', () => {
  it('drops blank fields, upper-cases the country, and is null for an empty address', () => {
    expect(cleanAddress({ ...emptyAddress(), name: ' Ada ', city: 'Utrecht', country: 'nl' })).toEqual({ name: 'Ada', city: 'Utrecht', country: 'NL' });
    expect(cleanAddress(emptyAddress())).toBeNull();
  });
});

describe('lineIsComplete', () => {
  it('needs a whole quantity, and for a free line a name and a price', () => {
    expect(lineIsComplete(catalogLine)).toBe(true);
    expect(lineIsComplete({ ...catalogLine, quantity: 0 })).toBe(false);
    expect(lineIsComplete({ ...catalogLine, quantity: 1.5 })).toBe(false);
    expect(lineIsComplete({ ...catalogLine, unitPrice: 'abc' })).toBe(false);
    expect(lineIsComplete(freeLine)).toBe(true);
    expect(lineIsComplete({ ...freeLine, name: ' ' })).toBe(false);
    expect(lineIsComplete({ ...freeLine, unitPrice: '' })).toBe(false);
  });
});

describe('toOrderInput', () => {
  it('builds the create body: catalogue lines by variant or product, free lines by name', () => {
    const values = {
      ...emptyOrderValues('eur'),
      companyId: 'comp_1',
      customerEmail: ' ada@example.com ',
      items: [catalogLine, variantLine, freeLine],
      discountCode: ' SPRING ',
      shippingTotal: '6.95',
      billingAddress: { ...emptyAddress(), city: 'Utrecht' },
      customerReference: 'PO-77',
    };
    expect(toOrderInput(values)).toEqual({
      companyId: 'comp_1',
      personId: null,
      customerName: null,
      customerEmail: 'ada@example.com',
      customerPhone: null,
      currency: 'EUR',
      items: [
        { productId: 'prod_1', quantity: 2, unitPrice: null },
        { variantId: 'var_2', quantity: 2, unitPrice: '12.50' },
        { name: 'Installation', quantity: 1, unitPrice: '75.00' },
      ],
      discountCode: 'SPRING',
      shippingTotal: '6.95',
      billingAddress: { city: 'Utrecht' },
      shippingAddress: null,
      customerReference: 'PO-77',
      customerNote: null,
      internalNote: null,
      status: 'confirmed',
    });
  });
});

describe('toQuoteRequest', () => {
  it('asks nothing without a valid currency or a priceable line', () => {
    expect(toQuoteRequest({ ...emptyOrderValues('EUR'), items: [] })).toBeNull();
    expect(toQuoteRequest({ ...emptyOrderValues('EU'), items: [catalogLine] })).toBeNull();
    expect(toQuoteRequest({ ...emptyOrderValues('EUR'), items: [{ ...freeLine, name: '' }] })).toBeNull();
  });

  it('leaves out lines still being typed and remembers which form line each quoted line is', () => {
    const request = toQuoteRequest({
      ...emptyOrderValues('eur'),
      items: [{ ...freeLine, name: '' }, catalogLine, freeLine],
      shippingTotal: '5',
      discountCode: 'SPRING',
    });
    expect(request?.lineIndexes).toEqual([1, 2]);
    expect(request?.input).toEqual({
      companyId: null,
      personId: null,
      currency: 'EUR',
      items: [
        { productId: 'prod_1', quantity: 2, unitPrice: null },
        { name: 'Installation', quantity: 1, unitPrice: '75.00' },
      ],
      discountCode: 'SPRING',
      shippingTotal: '5',
    });
  });

  it('does not send a shipping amount that is not money yet', () => {
    expect(toQuoteRequest({ ...emptyOrderValues('EUR'), items: [catalogLine], shippingTotal: '5,' })?.input.shippingTotal).toBeNull();
  });
});

const order = {
  id: 'ord_1',
  orderNumber: 'WC-1001',
  currency: 'EUR',
  companyId: 'comp_1',
  companyName: 'Acme',
  personId: 'per_1',
  customerName: 'Ada',
  customerEmail: 'ada@example.com',
  customerPhone: null,
  shippingTotal: '6.95',
  discountCode: null,
  billingAddress: { city: 'Utrecht', country: 'NL' },
  shippingAddress: null,
  customerReference: null,
  customerNote: 'Leave at the door',
  internalNote: null,
  editable: true,
  items: [
    { id: 'item_1', productId: 'prod_1', variantId: null, sku: 'S', name: 'Shirt', variantName: null, quantity: 2, unitPrice: '10.00' },
  ],
} as unknown as Order;

describe('editing an order', () => {
  it('starts from the order, keeping each item id and price', () => {
    const values = valuesFromOrder(order);
    expect(values.companyName).toBe('Acme');
    expect(values.billingAddress.city).toBe('Utrecht');
    expect(values.items).toEqual([
      { itemId: 'item_1', productId: 'prod_1', variantId: null, sku: 'S', name: 'Shirt', variantName: null, quantity: 2, unitPrice: '10.00' },
    ]);
  });

  it('patches everything while the order is editable, with the item ids so lines update in place', () => {
    const values = { ...valuesFromOrder(order), items: [...valuesFromOrder(order).items, catalogLine] };
    const patch = toOrderPatch(values, order);
    expect(patch.companyId).toBe('comp_1');
    expect(patch.shippingTotal).toBe('6.95');
    expect(patch.items).toEqual([
      { id: 'item_1', productId: 'prod_1', quantity: 2, unitPrice: '10.00' },
      { productId: 'prod_1', quantity: 2, unitPrice: null },
    ]);
    expect(patch.customerNote).toBe('Leave at the door');
  });

  it('patches only addresses, reference and notes once the order is no longer editable', () => {
    const patch = toOrderPatch(valuesFromOrder(order), { ...order, editable: false });
    expect(Object.keys(patch).sort()).toEqual(
      ['billingAddress', 'customerNote', 'customerReference', 'internalNote', 'shippingAddress'].sort(),
    );
  });
});

describe('buildOrderFormSchema', () => {
  const schema = buildOrderFormSchema();
  const valid = { ...emptyOrderValues('EUR'), items: [catalogLine] };

  it('accepts a priced catalogue line, a blank price and an empty address', () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it('asks for at least one item', () => {
    const result = schema.safeParse({ ...valid, items: [] });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues[0]?.message).toBe('Add at least one item.');
  });

  it('asks a free line for a name and a price', () => {
    const result = schema.safeParse({ ...valid, items: [{ ...freeLine, name: '', unitPrice: '' }] });
    expect(result.success).toBe(false);
    const messages = !result.success ? result.error.issues.map((issue) => issue.message) : [];
    expect(messages).toEqual(expect.arrayContaining(['Describe this line.', 'Enter a price for this line.']));
  });

  it('rejects a bad currency, amount, email and country', () => {
    const result = schema.safeParse({
      ...valid,
      currency: 'EURO',
      shippingTotal: '1,5',
      customerEmail: 'nope',
      billingAddress: { ...emptyAddress(), country: 'NLD' },
    });
    expect(result.success).toBe(false);
    const paths = !result.success ? result.error.issues.map((issue) => issue.path.join('.')) : [];
    expect(paths).toEqual(expect.arrayContaining(['currency', 'shippingTotal', 'customerEmail', 'billingAddress.country']));
  });
});
