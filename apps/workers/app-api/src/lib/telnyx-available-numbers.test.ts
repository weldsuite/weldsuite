import { describe, it, expect } from 'vitest';
import {
  applyTelephonyMarkupMajor,
  applyTelephonyMarkupToCost,
  mapTelnyxAvailableNumber,
  pricingLookupKey,
  resolveTelephonyMarkup,
} from './telnyx-available-numbers';

describe('mapTelnyxAvailableNumber', () => {
  it('fills iso_country from region_information country_code', () => {
    const mapped = mapTelnyxAvailableNumber(
      {
        phone_number: '+19705555098',
        region_information: [
          { region_type: 'country_code', region_name: 'US' },
          { region_type: 'state', region_name: 'IL' },
          { region_type: 'rate_center', region_name: 'CHICAGO' },
        ],
        features: [{ name: 'voice' }, { name: 'sms' }],
        cost_information: { currency: 'USD', monthly_cost: '6.54', upfront_cost: '1.00' },
      },
      'BE',
    );
    expect(mapped).toMatchObject({
      phone_number: '+19705555098',
      iso_country: 'US',
      region: 'IL',
      locality: 'CHICAGO',
      capabilities: { voice: true, sms: true, mms: false },
    });
  });

  it('falls back to the search country when Telnyx omits region_information', () => {
    const mapped = mapTelnyxAvailableNumber({ phone_number: '+32475123456' }, 'be');
    expect(mapped?.iso_country).toBe('BE');
  });

  it('drops rows without a phone number', () => {
    expect(mapTelnyxAvailableNumber({}, 'US')).toBeNull();
  });
});

describe('pricingLookupKey', () => {
  it('normalizes country case and toll_free vs toll-free', () => {
    expect(pricingLookupKey('us', 'toll_free')).toBe('US:toll-free');
    expect(pricingLookupKey('NL', 'local')).toBe('NL:local');
  });
});

describe('applyTelephonyMarkupMajor', () => {
  it('adds a percent markup onto wholesale', () => {
    expect(applyTelephonyMarkupMajor('5.00', { markupAmount: null, markupPercent: '20' })).toBe('6.00');
  });

  it('adds a flat cents markup onto wholesale', () => {
    expect(applyTelephonyMarkupMajor('5.00', { markupAmount: 150, markupPercent: null })).toBe('6.50');
  });

  it('leaves wholesale unchanged when there is no markup', () => {
    expect(applyTelephonyMarkupMajor('5.00', { markupAmount: null, markupPercent: null })).toBe('5.00');
  });
});

describe('resolveTelephonyMarkup', () => {
  const defaultRow = {
    countryCode: '*',
    numberType: '*',
    markupAmount: null,
    markupPercent: '20.00',
  };
  const nlLocal = {
    countryCode: 'NL',
    numberType: 'local',
    markupAmount: 200,
    markupPercent: null,
  };

  it('prefers the country+type row over the default sentinel', () => {
    expect(resolveTelephonyMarkup([defaultRow, nlLocal], 'nl', 'local')).toEqual(nlLocal);
  });

  it('falls back to the default sentinel', () => {
    expect(resolveTelephonyMarkup([defaultRow], 'NL', 'local')).toEqual(defaultRow);
  });
});

describe('applyTelephonyMarkupToCost', () => {
  it('marks up Telnyx monthly and upfront costs', () => {
    expect(
      applyTelephonyMarkupToCost(
        { currency: 'USD', monthly_cost: '10.00', upfront_cost: '1.00' },
        { markupAmount: null, markupPercent: '10' },
      ),
    ).toEqual({ currency: 'USD', monthly_cost: '11.00', upfront_cost: '1.10' });
  });
});
