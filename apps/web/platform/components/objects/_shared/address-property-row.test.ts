import { describe, expect, it } from 'vitest';
import { buildAddressPatch, formatStoredAddress, toPostalAddress } from './address-property-row';

describe('address property helpers', () => {
  it('normalizes the legacy street/houseNumber shape to line1', () => {
    expect(toPostalAddress({ street: 'Keizersgracht', houseNumber: '12', city: 'Amsterdam' })).toMatchObject({
      line1: 'Keizersgracht 12',
      city: 'Amsterdam',
    });
  });

  it('formats the shared shape on one line with the country name', () => {
    expect(
      formatStoredAddress({ line1: 'Keizersgracht 12', postalCode: '1015 CJ', city: 'Amsterdam', country: 'NL' }, 'en'),
    ).toBe('Keizersgracht 12, 1015 CJ Amsterdam, Netherlands');
  });

  it('returns an empty string for no address', () => {
    expect(formatStoredAddress(null)).toBe('');
    expect(formatStoredAddress({})).toBe('');
  });

  it('builds a patch in the shared shape, dropping legacy street keys but keeping unknown extras', () => {
    const patch = buildAddressPatch(
      { street: 'Old', houseNumber: '1', province: 'NH', geo: { lat: 1 } },
      { line1: ' New street 5 ', city: 'Utrecht', country: 'nl', postalCode: '', state: '', line2: '' },
    );
    expect(patch).toEqual({ geo: { lat: 1 }, line1: 'New street 5', city: 'Utrecht', country: 'NL' });
  });

  it('returns null when every field was cleared', () => {
    expect(buildAddressPatch({ line1: 'x' }, { line1: ' ', city: '' })).toBeNull();
  });
});
