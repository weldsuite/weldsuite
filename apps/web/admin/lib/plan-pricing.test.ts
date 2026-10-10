import { describe, expect, it } from 'vitest';
import { parseCountryPricingInput, toCountryPricingInput, type CountryPricingInput } from './plan-pricing';

const input = (overrides: Partial<CountryPricingInput> = {}): CountryPricingInput => ({
  country: 'nl',
  currency: 'eur',
  plans: {
    business: { monthly: '39', annual: '33,50' },
    scale: { monthly: '59', annual: '' },
    enterprise: { monthly: '', annual: '' },
  },
  ...overrides,
});

describe('parseCountryPricingInput', () => {
  it('normalises codes, accepts comma decimals and leaves empty plans on request', () => {
    const result = parseCountryPricingInput(input());
    expect(result).toEqual({
      ok: true,
      country: 'NL',
      pricing: {
        currency: 'EUR',
        plans: {
          business: { monthly: 39, annual: 33.5 },
          scale: { monthly: 59, annual: null },
        },
      },
    });
  });

  it('rejects bad codes and prices', () => {
    expect(parseCountryPricingInput(input({ country: 'NLD' }))).toMatchObject({ ok: false, code: 'country_invalid' });
    expect(parseCountryPricingInput(input({ currency: 'EU' }))).toMatchObject({ ok: false, code: 'currency_invalid' });
    const plans = input().plans;
    expect(
      parseCountryPricingInput(input({ plans: { ...plans, scale: { monthly: 'abc', annual: '' } } })),
    ).toMatchObject({ ok: false, code: 'price_invalid', plan: 'scale' });
    expect(
      parseCountryPricingInput(input({ plans: { ...plans, scale: { monthly: '0', annual: '' } } })),
    ).toMatchObject({ ok: false, code: 'price_invalid', plan: 'scale' });
    expect(
      parseCountryPricingInput(input({ plans: { ...plans, scale: { monthly: '59.999', annual: '' } } })),
    ).toMatchObject({ ok: false, code: 'price_invalid', plan: 'scale' });
    expect(
      parseCountryPricingInput(input({ plans: { ...plans, enterprise: { monthly: '', annual: '90' } } })),
    ).toMatchObject({ ok: false, code: 'annual_without_monthly', plan: 'enterprise' });
    expect(
      parseCountryPricingInput(input({ plans: { ...plans, business: { monthly: '39', annual: '45' } } })),
    ).toMatchObject({ ok: false, code: 'annual_above_monthly', plan: 'business' });
  });

  it('round-trips a stored entry through the form', () => {
    const parsed = parseCountryPricingInput(input());
    if (!parsed.ok) throw new Error('expected ok');
    expect(parseCountryPricingInput(toCountryPricingInput(parsed.country, parsed.pricing))).toEqual(parsed);
  });
});
