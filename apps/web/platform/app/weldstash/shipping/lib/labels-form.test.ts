import { describe, expect, it } from 'vitest';
import type { CarrierProduct, PickListShipping } from '@weldsuite/app-api-client/schemas/shipping';
import {
  buildLabelsInput,
  buildQuoteInput,
  kgToGrams,
  makeLabelsFormSchema,
  parseDecimal,
  shippingToFormValues,
  type LabelsFormValues,
} from './labels-form';

const messages = { required: 'required', invalidWeight: 'weight', invalidNumber: 'number', invalidQuantity: 'quantity' };

const shipping: PickListShipping = {
  pickListId: 'pl_1',
  status: 'packed',
  orderId: 'ord_1',
  orderNumber: 'SO-1',
  recipient: {
    name: 'Jan Jansen',
    company: null,
    street: 'Stationsstraat',
    houseNumber: '12',
    houseNumberSuffix: 'A',
    line1: 'Stationsstraat 12A',
    postalCode: '1012LG',
    city: 'Amsterdam',
    country: 'nl',
    email: 'jan@example.com',
  },
  sender: {},
  suggestedWeightGrams: 1250,
  customsRequired: false,
  customs: { content: 'sale_of_goods', invoiceNumber: null, currency: 'EUR', lines: [] },
  servicePoint: null,
  defaultCarrierId: 'car_1',
  parcels: [],
};

const product: CarrierProduct = {
  code: 'parcel',
  name: 'Parcel',
  servicePoint: false,
  multiCollo: false,
  mailbox: false,
  returns: true,
  options: ['signature', 'insurance', 'returnLabel'],
};

function values(overrides: Partial<LabelsFormValues> = {}): LabelsFormValues {
  return { ...shippingToFormValues(shipping), product: 'parcel', ...overrides };
}

describe('numbers', () => {
  it('reads a point or a comma as the decimal separator', () => {
    expect(parseDecimal('1,5')).toBe(1.5);
    expect(parseDecimal(' 2.25 ')).toBe(2.25);
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal('')).toBeNull();
  });

  it('converts kilograms to whole grams', () => {
    expect(kgToGrams('1,25')).toBe(1250);
    expect(kgToGrams('0.0004')).toBe(0);
  });
});

describe('shippingToFormValues', () => {
  it('prefills the piece weight, carrier and recipient from the pick list', () => {
    const form = shippingToFormValues(shipping);
    expect(form.carrierId).toBe('car_1');
    expect(form.pieces).toEqual([{ weightKg: '1.25', lengthCm: '', widthCm: '', heightCm: '' }]);
    expect(form.recipient).toMatchObject({ street: 'Stationsstraat', houseNumber: '12', houseNumberSuffix: 'A', country: 'NL' });
  });
});

describe('buildLabelsInput', () => {
  it('sends only the options the product lists, plus the insured value in cents', () => {
    const input = buildLabelsInput(values({ signature: true, ageCheck: true, insuredValue: '150,50' }), {
      product,
      servicePoint: null,
      customsRequired: false,
    });
    expect(input.options).toEqual({ signature: true, insuredValueCents: 15050 });
    expect(input.pieces).toEqual([{ weightGrams: 1250 }]);
    expect(input.recipient?.line1).toBe('Stationsstraat 12A');
  });

  it('keeps one piece unless the product is multi-collo', () => {
    const two = values({ pieces: [shippingToFormValues(shipping).pieces[0], { weightKg: '2', lengthCm: '', widthCm: '', heightCm: '' }] });
    expect(buildLabelsInput(two, { product, servicePoint: null, customsRequired: false }).pieces).toHaveLength(1);
    expect(buildLabelsInput(two, { product: { ...product, multiCollo: true }, servicePoint: null, customsRequired: false }).pieces).toHaveLength(2);
  });

  it('adds the return label only when the product supports it', () => {
    const withReturn = values({ returnLabel: true });
    expect(buildLabelsInput(withReturn, { product, servicePoint: null, customsRequired: false }).returnLabel).toBe(true);
    expect(buildLabelsInput(withReturn, { product: { ...product, returns: false, options: [] }, servicePoint: null, customsRequired: false }).returnLabel).toBeUndefined();
  });

  it('adds customs with values in cents when they are required', () => {
    const form = values({
      customs: {
        content: 'gift',
        invoiceNumber: 'INV-1',
        currency: 'gbp',
        lines: [{ description: 'Mug', quantity: '2', value: '12,50', weightGrams: '300', hsCode: '6912', originCountry: 'nl' }],
      },
    });
    const input = buildLabelsInput(form, { product, servicePoint: null, customsRequired: true });
    expect(input.customs).toEqual({
      content: 'gift',
      invoiceNumber: 'INV-1',
      currency: 'GBP',
      lines: [{ description: 'Mug', quantity: 2, valueCents: 1250, weightGrams: 300, hsCode: '6912', originCountry: 'NL' }],
    });
  });
});

describe('buildQuoteInput', () => {
  it('is null until there is a product and a weight', () => {
    expect(buildQuoteInput(values(), undefined)).toBeNull();
    expect(buildQuoteInput(values({ pieces: [{ weightKg: '', lengthCm: '', widthCm: '', heightCm: '' }] }), product)).toBeNull();
    expect(buildQuoteInput(values(), product)).toMatchObject({ product: 'parcel', toCountry: 'NL', pieces: [{ weightGrams: 1250 }] });
  });
});

describe('makeLabelsFormSchema', () => {
  it('requires a weight above zero and a recipient', () => {
    const schema = makeLabelsFormSchema(messages, { customsRequired: false });
    expect(schema.safeParse(values()).success).toBe(true);
    const bad = schema.safeParse(values({ pieces: [{ weightKg: '0', lengthCm: '', widthCm: '', heightCm: '' }] }));
    expect(bad.success).toBe(false);
  });

  it('checks the customs lines only when customs are required', () => {
    const form = values({
      customs: { content: 'sale_of_goods', invoiceNumber: '', currency: 'EUR', lines: [{ description: '', quantity: '0', value: '', weightGrams: '', hsCode: '', originCountry: '' }] },
    });
    expect(makeLabelsFormSchema(messages, { customsRequired: false }).safeParse(form).success).toBe(true);
    const result = makeLabelsFormSchema(messages, { customsRequired: true }).safeParse(form);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['customs.lines.0.description', 'customs.lines.0.quantity', 'customs.lines.0.value', 'customs.lines.0.originCountry']));
    }
  });
});
