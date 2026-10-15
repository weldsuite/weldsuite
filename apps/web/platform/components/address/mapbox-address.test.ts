import { describe, it, expect } from 'vitest';
import type { MapboxSuggestion } from '@/app/weldcalendar/lib/mapbox-search';
import { mapboxToPostalAddress, needsMapboxRetrieve } from './mapbox-address';

const base = { mapbox_id: 'id', full_address: '', place_formatted: '' };

describe('mapboxToPostalAddress', () => {
  it('fills every field from a street address, with the ISO country', () => {
    const s: MapboxSuggestion = {
      ...base,
      name: 'Keizersgracht 12',
      feature_type: 'address',
      address: 'Keizersgracht 12',
      context: {
        country: { name: 'Netherlands', country_code: 'nl' },
        region: { name: 'North Holland', region_code: 'NH' },
        postcode: { name: '1015 CJ' },
        place: { name: 'Amsterdam' },
      },
    };
    expect(mapboxToPostalAddress(s)).toEqual({
      line1: 'Keizersgracht 12',
      city: 'Amsterdam',
      state: 'North Holland',
      postalCode: '1015 CJ',
      country: 'NL',
    });
    expect(needsMapboxRetrieve(s)).toBe(false);
  });

  it('stores a US state as its USPS code', () => {
    const s: MapboxSuggestion = {
      ...base,
      name: '1 Infinite Loop',
      feature_type: 'address',
      context: {
        country: { name: 'United States', country_code: 'us' },
        region: { name: 'California', region_code: 'CA' },
        place: { name: 'Cupertino' },
      },
    };
    expect(mapboxToPostalAddress(s)).toMatchObject({ line1: '1 Infinite Loop', state: 'CA', country: 'US' });
    // No postcode in the suggestion: worth a /retrieve.
    expect(needsMapboxRetrieve(s)).toBe(true);
  });

  it('uses the street, not the business name, for a POI', () => {
    const s: MapboxSuggestion = {
      ...base,
      name: 'Rijksmuseum',
      feature_type: 'poi',
      address: 'Museumstraat 1',
      context: { country: { country_code: 'NL' }, place: { name: 'Amsterdam' }, postcode: { name: '1071 XX' } },
    };
    expect(mapboxToPostalAddress(s)).toMatchObject({ line1: 'Museumstraat 1', city: 'Amsterdam' });
  });

  it('maps a city, a region and a country to just those parts', () => {
    expect(
      mapboxToPostalAddress({
        ...base,
        name: 'Duisburg',
        feature_type: 'place',
        context: { country: { country_code: 'DE' }, region: { name: 'North Rhine-Westphalia' } },
      }),
    ).toEqual({ city: 'Duisburg', state: 'North Rhine-Westphalia', country: 'DE' });
    expect(
      mapboxToPostalAddress({ ...base, name: 'Bavaria', feature_type: 'region', context: { country: { country_code: 'DE' } } }),
    ).toEqual({ state: 'Bavaria', country: 'DE' });
    // A country result without a code still resolves from its name.
    expect(mapboxToPostalAddress({ ...base, name: 'Germany', feature_type: 'country' })).toEqual({ country: 'DE' });
  });
});
