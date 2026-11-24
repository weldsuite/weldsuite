import { describe, expect, it } from 'vitest';
import {
  CARRIER_CODES,
  CARRIER_CONTRACTS,
  CUSTOMS_CONTENT_TYPES,
  LABEL_FORMATS,
  PARCEL_STATUSES,
  SHIPPING_OPTION_KEYS,
  addressInputSchema,
  carrierSettingsSchema,
  createCarrierSchema,
  createLabelsSchema,
  createReturnLabelSchema,
  customsInputSchema,
  customsLineSchema,
  pieceInputSchema,
  quoteInputSchema,
  shipmentOptionsSchema,
  updateCarrierSchema,
} from './shipping';

describe('shipping constants', () => {
  it('lists the carriers, formats, contracts and statuses the backend names', () => {
    expect(CARRIER_CODES).toEqual(['postnl', 'dhl_parcel_nl']);
    expect(LABEL_FORMATS).toEqual(['pdf_a6', 'pdf_a4', 'zpl']);
    expect(CARRIER_CONTRACTS).toEqual(['own', 'weldsuite', 'manual']);
    expect(SHIPPING_OPTION_KEYS[0]).toBe('signature');
    expect(CUSTOMS_CONTENT_TYPES).toContain('sale_of_goods');
    expect(PARCEL_STATUSES[0]).toBe('draft');
    expect(PARCEL_STATUSES).toContain('delivered');
  });
});

describe('addressInputSchema', () => {
  it('accepts partial addresses with null fields', () => {
    expect(addressInputSchema.parse({ name: 'Ann', street: null, postalCode: '1012LG' })).toEqual({
      name: 'Ann',
      street: null,
      postalCode: '1012LG',
    });
  });

  it('rejects a non-string field', () => {
    expect(addressInputSchema.safeParse({ city: 5 }).success).toBe(false);
  });
});

describe('carrier schemas', () => {
  it('parses carrier settings and rejects an unknown label format', () => {
    expect(carrierSettingsSchema.parse({ sandbox: true, labelFormat: 'zpl', senderAddress: null }).labelFormat).toBe('zpl');
    expect(carrierSettingsSchema.safeParse({ labelFormat: 'png' }).success).toBe(false);
  });

  it('createCarrierSchema trims the name and requires a known code and contract', () => {
    const parsed = createCarrierSchema.parse({ code: 'postnl', contract: 'own', name: '  Main  ', credentials: { apiKey: 'k' } });
    expect(parsed.name).toBe('Main');
    expect(createCarrierSchema.safeParse({ code: 'ups', contract: 'own' }).success).toBe(false);
    expect(createCarrierSchema.safeParse({ code: 'postnl', contract: 'manual' }).success).toBe(false);
    expect(createCarrierSchema.safeParse({ code: 'postnl', contract: 'own', name: 'x'.repeat(121) }).success).toBe(false);
  });

  it('updateCarrierSchema makes everything optional and drops the code', () => {
    expect(updateCarrierSchema.parse({ isDefault: true })).toEqual({ isDefault: true });
    expect(updateCarrierSchema.parse({})).toEqual({});
    expect(updateCarrierSchema.parse({ code: 'postnl' })).toEqual({});
  });
});

describe('quote and shipment schemas', () => {
  it('shipmentOptionsSchema takes whole-cent insured values only', () => {
    expect(shipmentOptionsSchema.safeParse({ signature: true, insuredValueCents: 500 }).success).toBe(true);
    expect(shipmentOptionsSchema.safeParse({ insuredValueCents: 5.5 }).success).toBe(false);
    expect(shipmentOptionsSchema.safeParse({ insuredValueCents: -1 }).success).toBe(false);
  });

  it('pieceInputSchema needs at least one gram', () => {
    expect(pieceInputSchema.safeParse({ weightGrams: 1, lengthCm: 10 }).success).toBe(true);
    expect(pieceInputSchema.safeParse({ weightGrams: 0 }).success).toBe(false);
    expect(pieceInputSchema.safeParse({ weightGrams: 10, widthCm: -1 }).success).toBe(false);
  });

  it('quoteInputSchema needs a two-letter country and a piece', () => {
    expect(quoteInputSchema.safeParse({ toCountry: 'NL', pieces: [{ weightGrams: 500 }] }).success).toBe(true);
    expect(quoteInputSchema.safeParse({ toCountry: 'NLD', pieces: [{ weightGrams: 500 }] }).success).toBe(false);
    expect(quoteInputSchema.safeParse({ toCountry: 'NL', pieces: [] }).success).toBe(false);
  });
});

describe('customs schemas', () => {
  const line = { description: 'Shirt', quantity: 2, valueCents: 2500, weightGrams: 300 };

  it('customsLineSchema requires a positive quantity', () => {
    expect(customsLineSchema.parse({ ...line, hsCode: null }).quantity).toBe(2);
    expect(customsLineSchema.safeParse({ ...line, quantity: 0 }).success).toBe(false);
  });

  it('customsInputSchema needs a known content type and a three-letter currency', () => {
    const ok = { content: 'gift', currency: 'EUR', lines: [line] };
    expect(customsInputSchema.safeParse(ok).success).toBe(true);
    expect(customsInputSchema.safeParse({ ...ok, content: 'loot' }).success).toBe(false);
    expect(customsInputSchema.safeParse({ ...ok, currency: 'EURO' }).success).toBe(false);
  });
});

describe('label schemas', () => {
  it('createLabelsSchema needs a piece and accepts a service point and customs', () => {
    const base = { pieces: [{ weightGrams: 800 }] };
    expect(createLabelsSchema.safeParse(base).success).toBe(true);
    expect(createLabelsSchema.safeParse({ pieces: [] }).success).toBe(false);
    expect(
      createLabelsSchema.safeParse({
        ...base,
        carrierId: 'car_1',
        servicePoint: { id: 'sp_1', name: 'Shop', address: { city: 'Amsterdam', street: null }, networkId: null },
        customs: { content: 'documents', currency: 'GBP', lines: [] },
        labelFormat: 'pdf_a4',
        returnLabel: true,
      }).success,
    ).toBe(true);
    expect(createLabelsSchema.safeParse({ ...base, labelFormat: 'gif' }).success).toBe(false);
  });

  it('createReturnLabelSchema takes an optional weight and format', () => {
    expect(createReturnLabelSchema.parse({})).toEqual({});
    expect(createReturnLabelSchema.safeParse({ weightGrams: 0 }).success).toBe(false);
    expect(createReturnLabelSchema.parse({ weightGrams: 400, labelFormat: 'zpl' }).labelFormat).toBe('zpl');
  });
});
