/**
 * The shared VAT / tax ID format check (`@weldsuite/app-api-client/schemas/vat-number`).
 *
 * @weldsuite/app-api-client has no test runner of its own; the validator is exercised here
 * because app-api is its server-side consumer (PUT /api/workspace-settings).
 * The platform's Business settings form and Billing details dialog use the
 * same function.
 */

import { describe, it, expect } from 'vitest';
import {
  checkVatNumber,
  isValidVatNumber,
  normalizeVatNumber,
  vatPlaceholderForCountry,
  vatPrefixForCountry,
} from '@weldsuite/app-api-client/schemas/vat-number';

describe('checkVatNumber', () => {
  it('allows an empty value (the field is optional)', () => {
    expect(isValidVatNumber('', 'NL')).toBe(true);
    expect(isValidVatNumber('   ', 'NL')).toBe(true);
    expect(isValidVatNumber(null, 'NL')).toBe(true);
    expect(isValidVatNumber(undefined)).toBe(true);
  });

  it.each([
    ['NL123456789B01', 'NL'],
    ['nl 1234.56.789 b01', 'NL'],
    ['123456789B01', 'NL'],
    ['BE0123456789', 'BE'],
    ['BE 0123.456.789', 'BE'],
    ['0123456789', 'BE'],
    ['DE123456789', 'DE'],
    ['123456789', 'DE'],
    ['FR12345678901', 'FR'],
    ['ATU12345678', 'AT'],
    ['EL123456789', 'GR'],
    ['GR123456789', 'GR'],
    ['GB123456789', 'GB'],
    ['GB123456789012', 'GB'],
    ['XI123456789', 'GB'],
  ])('accepts %s for %s', (value, country) => {
    expect(isValidVatNumber(value, country)).toBe(true);
  });

  it.each([
    ['NOT A VAT!!', 'NL'],
    ['NL123456789', 'NL'],
    ['NL123456789B1', 'NL'],
    ['123456789', 'NL'],
    ['BE2123456789', 'BE'],
    ['BE012345678', 'BE'],
    ['DE12345678', 'DE'],
    ['DE1234567890', 'DE'],
    ['GB12345', 'GB'],
    ['hello', 'DE'],
  ])('rejects %s for %s', (value, country) => {
    expect(isValidVatNumber(value, country)).toBe(false);
  });

  it('checks a typed EU prefix against that country, even for another EU country', () => {
    expect(isValidVatNumber('BE0123456789', 'NL')).toBe(true);
    expect(checkVatNumber('BE012345', 'NL')).toMatchObject({ valid: false, prefix: 'BE', example: 'BE0123456789' });
  });

  it('reports the prefix and example of the failed country', () => {
    expect(checkVatNumber('NOT A VAT!!', 'NL')).toMatchObject({
      valid: false,
      prefix: 'NL',
      example: 'NL123456789B01',
      compact: 'NOTAVAT!!',
    });
  });

  it('applies the lenient check to countries without a VAT pattern', () => {
    expect(isValidVatNumber('12-3456789', 'US')).toBe(true); // EIN
    expect(isValidVatNumber('27AAPFU0939F1ZV', 'IN')).toBe(true); // GSTIN
    expect(isValidVatNumber('CHE-123.456.789 MWST', 'CH')).toBe(true); // Swiss UID
    // A non-EU tax ID that happens to start with an EU prefix is not judged as that country.
    expect(isValidVatNumber('ITE980101AB1', 'MX')).toBe(true);

    expect(isValidVatNumber('NOT A VAT!!', 'US')).toBe(false);
    expect(isValidVatNumber('NOTAVAT', 'US')).toBe(false); // no digit
    expect(isValidVatNumber('A1', 'US')).toBe(false); // too short
    expect(checkVatNumber('NOT A VAT!!', 'US')).toMatchObject({ prefix: null, example: null });
  });

  it('without a country, checks a typed EU prefix and is lenient otherwise', () => {
    expect(isValidVatNumber('NL123456789B01')).toBe(true);
    expect(isValidVatNumber('NL123')).toBe(false);
    expect(isValidVatNumber('123456789')).toBe(true);
    expect(isValidVatNumber('NOT A VAT!!')).toBe(false);
  });

  it('ignores a country value that is not an ISO alpha-2 code', () => {
    expect(isValidVatNumber('123456789', 'Netherlands')).toBe(true);
    expect(isValidVatNumber('NOT A VAT!!', 'Netherlands')).toBe(false);
  });
});

describe('helpers', () => {
  it('normalizes separators and case', () => {
    expect(normalizeVatNumber(' nl 1234.56-789/b01 ')).toBe('NL123456789B01');
    expect(normalizeVatNumber(null)).toBe('');
  });

  it('maps countries to VAT prefixes', () => {
    expect(vatPrefixForCountry('nl')).toBe('NL');
    expect(vatPrefixForCountry('GR')).toBe('EL');
    expect(vatPrefixForCountry('US')).toBeNull();
    expect(vatPrefixForCountry('')).toBeNull();
  });

  it('gives a placeholder per country, Dutch by default', () => {
    expect(vatPlaceholderForCountry('BE')).toBe('BE0123456789');
    expect(vatPlaceholderForCountry('US')).toBe('NL123456789B01');
    expect(vatPlaceholderForCountry(undefined)).toBe('NL123456789B01');
  });
});
