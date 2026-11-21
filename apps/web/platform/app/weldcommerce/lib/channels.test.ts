import { describe, expect, it } from 'vitest';
import {
  EU_MEMBER_STATES,
  buildChannelFormSchema,
  buildKeyFormSchema,
  buildShippingRateFormSchema,
  countryName,
  countryNames,
  countryOptions,
  defaultPricesIncludeTax,
  emptyChannelValues,
  isValidOrigin,
  missingFields,
  moveRate,
  parseOrigins,
  toChannelInput,
  toMoneyString,
  toShippingRateInput,
} from './channels';

describe('countries', () => {
  it('lists the 27 EU member states, once each', () => {
    expect(EU_MEMBER_STATES).toHaveLength(27);
    expect(new Set(EU_MEMBER_STATES).size).toBe(27);
    expect(EU_MEMBER_STATES).not.toContain('GB');
  });

  it('names them in the UI language, sorted by name', () => {
    expect(countryName('NL')).toBe('Netherlands');
    expect(countryName('xx')).toBeTruthy();
    const labels = countryOptions(['NL', 'BE', 'AT']).map((o) => o.label);
    expect(labels).toEqual(['Austria', 'Belgium', 'Netherlands']);
    expect(countryNames(['BE', 'NL'])).toBe('Belgium, Netherlands');
  });
});

describe('channel form', () => {
  it('starts a B2C storefront with VAT in the prices, and follows the audience', () => {
    const values = emptyChannelValues('EUR');
    expect(values).toMatchObject({ type: 'storefront', audience: 'b2c', pricesIncludeTax: true, currency: 'EUR' });
    expect(defaultPricesIncludeTax('b2b')).toBe(false);
  });

  it('validates the name and the currency', () => {
    const schema = buildChannelFormSchema();
    expect(schema.safeParse({ ...emptyChannelValues('EU'), name: 'Shop' }).success).toBe(false);
    expect(schema.safeParse({ ...emptyChannelValues('EUR'), name: ' ' }).success).toBe(false);
    expect(schema.safeParse({ ...emptyChannelValues('EUR'), name: 'Shop' }).success).toBe(true);
  });

  it('sends a storefront with its countries and payment methods, and no invoice for consumers', () => {
    const body = toChannelInput(
      { ...emptyChannelValues('eur'), name: ' Shop ', sellingCountries: ['NL'], paymentMethods: ['mollie', 'invoice'] },
      'create',
    );
    expect(body).toEqual({
      name: 'Shop',
      type: 'storefront',
      audience: 'b2c',
      status: 'draft',
      currency: 'EUR',
      pricesIncludeTax: true,
      sellingCountries: ['NL'],
      guestCheckout: true,
      paymentMethods: ['mollie'],
    });
  });

  it('keeps the invoice for a business channel and leaves the type out of an update', () => {
    const body = toChannelInput(
      { ...emptyChannelValues('EUR'), name: 'B2B', audience: 'b2b', paymentMethods: ['invoice'] },
      'edit',
    );
    expect(body.paymentMethods).toEqual(['invoice']);
    expect(body).not.toHaveProperty('type');
  });

  it('sends a manual channel without countries, guest checkout or payment methods', () => {
    const body = toChannelInput({ ...emptyChannelValues('EUR'), name: 'Desk', type: 'manual', sellingCountries: ['NL'] }, 'create');
    expect(body).toMatchObject({ sellingCountries: [], guestCheckout: false, paymentMethods: [] });
  });

  it('sends a connector channel\'s name and status only', () => {
    const body = toChannelInput({ ...emptyChannelValues('EUR'), name: 'Shopify', type: 'shopify', status: 'active' }, 'edit');
    expect(body).toEqual({ name: 'Shopify', status: 'active' });
  });

  it('turns the refusal\'s missing list into words', () => {
    expect(missingFields({ missing: ['sellingCountries', 'paymentMethods', 'odd_thing'] })).toEqual([
      'At least one selling country',
      'At least one payment method',
      'odd thing',
    ]);
    expect(missingFields(undefined)).toEqual([]);
  });
});

describe('origins', () => {
  it('splits lines, commas and spaces, dropping blanks and repeats', () => {
    expect(parseOrigins('https://a.com\n\nhttps://b.com, https://a.com ')).toEqual(['https://a.com', 'https://b.com']);
  });

  it('accepts exact origins only', () => {
    expect(isValidOrigin('https://shop.example.com')).toBe(true);
    expect(isValidOrigin('http://localhost:3000')).toBe(true);
    expect(isValidOrigin('https://shop.example.com/')).toBe(false);
    expect(isValidOrigin('https://shop.example.com/path')).toBe(false);
    expect(isValidOrigin('shop.example.com')).toBe(false);
    expect(isValidOrigin('ftp://shop.example.com')).toBe(false);
  });

  it('wants an origin for a publishable key, not for a private one', () => {
    const schema = buildKeyFormSchema();
    expect(schema.safeParse({ kind: 'publishable', name: 'Web', origins: '' }).success).toBe(false);
    expect(schema.safeParse({ kind: 'publishable', name: 'Web', origins: 'https://a.com/x' }).success).toBe(false);
    expect(schema.safeParse({ kind: 'publishable', name: 'Web', origins: 'https://a.com' }).success).toBe(true);
    expect(schema.safeParse({ kind: 'private', name: 'Server', origins: '' }).success).toBe(true);
  });
});

describe('shipping rate form', () => {
  const valid = { zoneName: 'Benelux', countries: ['NL'], name: 'Standard', price: '4.9', freeShippingThreshold: '', active: true };

  it('validates zone, countries, name and amounts', () => {
    const schema = buildShippingRateFormSchema();
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, countries: [] }).success).toBe(false);
    expect(schema.safeParse({ ...valid, price: 'abc' }).success).toBe(false);
    expect(schema.safeParse({ ...valid, freeShippingThreshold: '1,5' }).success).toBe(false);
  });

  it('sends amounts with two decimals and a blank threshold as null', () => {
    expect(toMoneyString('4.9')).toBe('4.90');
    expect(toShippingRateInput(valid)).toEqual({
      zoneName: 'Benelux',
      countries: ['NL'],
      name: 'Standard',
      price: '4.90',
      freeShippingThreshold: null,
      active: true,
    });
    expect(toShippingRateInput({ ...valid, freeShippingThreshold: '50' }).freeShippingThreshold).toBe('50.00');
  });

  it('moves a rate one place, and stays put at the edges', () => {
    expect(moveRate(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveRate(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveRate(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveRate(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});
